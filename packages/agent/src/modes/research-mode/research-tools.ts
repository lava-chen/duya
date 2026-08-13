/**
 * Research mode tools (plan 423 Phase 2).
 *
 * Two model-facing tools are injected by research mode:
 *
 *  - `research_start`: enter research mode with a query. Called when the
 *    user asks the agent to research a topic; transitions the tracker
 *    `idle → clarifying` and seeds the research payload.
 *  - `research_report`: finalize the run. `completed: true` is only legal
 *    while synthesizing — it transitions `synthesizing → complete` and
 *    persists, so the lifecycle stays enforced by the pure state machine
 *    (a self-reported completion from any other state is rejected).
 *
 * Both persist the snapshot immediately on a real transition so a cold
 * session load can restore the run even without a live SSE event.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../../tool/registry.js';
import { researchModeTracker } from './research-tracker.js';
import type { ResearchState, ResearchEvent } from './research-tracker.js';
import {
  getResearchFanoutTool,
  RESEARCH_FANOUT_TOOL_NAME,
} from './research-fanout.js';
import { persistSnapshot } from '../engine/persistence.js';
import type { ModeTracker } from '../engine/tracker.js';
import { sendEvent, buildResearchUpdatedEvent } from '../../process/worker-protocol.js';

export const RESEARCH_START_TOOL_NAME = 'research_start';
export const RESEARCH_REPORT_TOOL_NAME = 'research_report';
export const RESEARCH_CONTINUE_TOOL_NAME = 'research_continue';
export const RESEARCH_ADVANCE_TOOL_NAME = 'research_advance';
export { RESEARCH_FANOUT_TOOL_NAME } from './research-fanout.js';

/**
 * Emit a `chat:research_updated` worker event for the renderer (plan 423
 * Phase 3 research status card). No-op when running outside the worker
 * protocol (unit tests / CLI harness) — sendEvent guards internally.
 */
export function emitResearchUpdated(sessionId?: string): void {
  if (!sessionId) return;
  sendEvent(
    buildResearchUpdatedEvent(sessionId, {
      state: researchModeTracker.state(),
      phase: researchModeTracker.phase(),
      query: researchModeTracker.query(),
      subQuestions: researchModeTracker.subQuestions(),
      sourcesGathered: researchModeTracker.sourcesGathered(),
      coverageGaps: researchModeTracker.coverageGaps(),
      rounds: researchModeTracker.rounds(),
      stallRounds: researchModeTracker.stallRounds(),
      history: researchModeTracker.history().map((h) => ({ at: h.at, event: h.event, detail: h.detail })),
    }) as unknown as Record<string, unknown>,
  );
}

/** Stable error codes for research tool rejections. */
export const RESEARCH_ERROR_CODES = {
  INVALID_INPUT: 'research_invalid_input',
  ALREADY_ACTIVE: 'research_already_active',
  NOT_SYNTHESIZING: 'research_report_not_synthesizing',
  COMPLETE: 'research_report_complete',
  NOT_PAUSED: 'research_continue_not_paused',
  NO_ADVANCE: 'research_advance_no_advance',
} as const;

export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[keyof typeof RESEARCH_ERROR_CODES];

const researchStartInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('The research topic or question to investigate.'),
});

const researchStartDefinition: Tool = {
  name: RESEARCH_START_TOOL_NAME,
  description:
    'Start a deep research investigation on the given query. Call this when the user asks you to research a topic. Returns the research state.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The research topic or question to investigate.',
      },
    },
    required: ['query'],
  },
};

const researchStartExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parse = researchStartInputSchema.safeParse(input);
    if (!parse.success) {
      return errorInput(RESEARCH_START_TOOL_NAME, parse.error.message);
    }
    const query = parse.data.query;
    const changed = researchModeTracker.transition({ type: 'start', query });
    if (changed) {
      const sessionId = context?.options.sessionId;
      if (sessionId) {
        await persistSnapshot(
          researchModeTracker as unknown as ModeTracker<string, string, unknown>,
          sessionId,
        );
      }
    }
    emitResearchUpdated(context?.options.sessionId);
    return {
      id: crypto.randomUUID(),
      name: RESEARCH_START_TOOL_NAME,
      result: JSON.stringify({
        started: changed,
        state: researchModeTracker.state(),
        phase: researchModeTracker.phase(),
        query: researchModeTracker.query(),
        message: changed
          ? 'Research started. Work through clarify → plan → search → evaluate, then call research_report(completed: true) when you synthesize the report.'
          : researchModeTracker.state() === 'idle'
            ? 'Research not started (empty query).'
            : `A research run is already ${
                researchModeTracker.state() === 'complete'
                  ? 'complete. Clear it (or start a fresh query) before beginning a new one.'
                  : `active (${researchModeTracker.state()}). Continue it or clear before starting a new one.`
              }`,
      }),
      error: changed ? false : true,
    };
  },
};

const researchReportInputSchema = z.object({
  completed: z
    .boolean()
    .describe('Whether the research report is fully written and ready to finalize.'),
  message: z
    .string()
    .optional()
    .describe('Optional completion summary or status message.'),
});

const researchReportDefinition: Tool = {
  name: RESEARCH_REPORT_TOOL_NAME,
  description:
    'Finalize the research run. Call with completed=true only when you have actually written the report while synthesizing — the lifecycle enforces this. Use a plain message for status updates.',
  input_schema: {
    type: 'object',
    properties: {
      completed: {
        type: 'boolean',
        description: 'Whether the research report is fully written and ready to finalize.',
      },
      message: {
        type: 'string',
        description: 'Optional completion summary or status message.',
      },
    },
    required: ['completed'],
  },
};

const researchReportExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parse = researchReportInputSchema.safeParse(input);
    if (!parse.success) {
      return errorInput(RESEARCH_REPORT_TOOL_NAME, parse.error.message);
    }
    const { completed, message } = parse.data;

    const state = researchModeTracker.state();
    if (state === 'idle') {
      return errorNoRun(RESEARCH_REPORT_TOOL_NAME);
    }
    if (state === 'complete') {
      return errorCompleted(RESEARCH_REPORT_TOOL_NAME);
    }

    if (completed) {
      // Only legal while synthesizing — the report must actually be written.
      if (state !== 'synthesizing') {
        return {
          id: crypto.randomUUID(),
          name: RESEARCH_REPORT_TOOL_NAME,
          result: JSON.stringify({
            error: `research_report(completed: true) is only valid while synthesizing (current state: ${state}). Write the report first, or gather/evaluate more evidence before finalizing.`,
            error_code: RESEARCH_ERROR_CODES.NOT_SYNTHESIZING,
          }),
          error: true,
        };
      }
      const changed = researchModeTracker.transition({ type: 'report_done' });
      if (changed) {
        const sessionId = context?.options.sessionId;
        if (sessionId) {
          await persistSnapshot(
            researchModeTracker as unknown as ModeTracker<string, string, unknown>,
            sessionId,
          );
        }
      }
      emitResearchUpdated(context?.options.sessionId);
      return {
        id: crypto.randomUUID(),
        name: RESEARCH_REPORT_TOOL_NAME,
        result: JSON.stringify({
          accepted: changed,
          state: researchModeTracker.state(),
          phase: researchModeTracker.phase(),
          query: researchModeTracker.query(),
          message: changed
            ? 'Research complete — report finalized.'
            : 'Research could not be finalized (unexpected state).',
        }),
        error: changed ? false : true,
      };
    }

    // Status-only update — no transition.
    return {
      id: crypto.randomUUID(),
      name: RESEARCH_REPORT_TOOL_NAME,
      result: JSON.stringify({
        accepted: true,
        state: researchModeTracker.state(),
        phase: researchModeTracker.phase(),
        query: researchModeTracker.query(),
        message: message ?? undefined,
      }),
      error: false,
    };
  },
};

const researchContinueInputSchema = z.object({
  instruction: z
    .string()
    .optional()
    .describe('Optional user answer / continuation note that resolves the pause.'),
});

/**
 * Resume a paused research run. Legal only while `awaiting_input` or
 * `blocked` (including a cold-restore fold): transitions via `user_input`
 * back to the remembered workflow state so the investigation continues.
 * A no-op status in every other active state; rejected when idle/complete.
 */
const researchContinueDefinition: Tool = {
  name: RESEARCH_CONTINUE_TOOL_NAME,
  description:
    'Resume a research run that is paused awaiting input (awaiting_input / blocked). Call this once the user has answered the pending question so the investigation continues. No-op if the research is already progressing.',
  input_schema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'Optional user answer / continuation note that resolves the pause.',
      },
    },
  },
};

const researchContinueExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parse = researchContinueInputSchema.safeParse(input);
    if (!parse.success) {
      return errorInput(RESEARCH_CONTINUE_TOOL_NAME, parse.error.message);
    }
    const { instruction } = parse.data;

    const state = researchModeTracker.state();
    if (state === 'idle') {
      return errorNoRun(RESEARCH_CONTINUE_TOOL_NAME);
    }
    if (state === 'complete') {
      return errorCompleted(RESEARCH_CONTINUE_TOOL_NAME);
    }
    if (state !== 'awaiting_input' && state !== 'blocked') {
      return {
        id: crypto.randomUUID(),
        name: RESEARCH_CONTINUE_TOOL_NAME,
        result: JSON.stringify({
          resumed: false,
          state: researchModeTracker.state(),
          phase: researchModeTracker.phase(),
          query: researchModeTracker.query(),
          message: `Research is already progressing (${state}) — nothing to resume.`,
          error_code: RESEARCH_ERROR_CODES.NOT_PAUSED,
        }),
        error: true,
      };
    }

    const changed = researchModeTracker.transition({ type: 'user_input' });
    if (changed) {
      const sessionId = context?.options.sessionId;
      if (sessionId) {
        await persistSnapshot(
          researchModeTracker as unknown as ModeTracker<string, string, unknown>,
          sessionId,
        );
      }
    }
    emitResearchUpdated(context?.options.sessionId);
    return {
      id: crypto.randomUUID(),
      name: RESEARCH_CONTINUE_TOOL_NAME,
      result: JSON.stringify({
        resumed: changed,
        state: researchModeTracker.state(),
        phase: researchModeTracker.phase(),
        query: researchModeTracker.query(),
        message: changed
          ? `Research resumed — back in ${researchModeTracker.state()} state.${instruction ? ` User note: ${instruction}` : ''}`
          : 'Research could not be resumed (unexpected state).',
      }),
      error: changed ? false : true,
    };
  },
};

/**
 * Advance the research lifecycle to its next phase. Legal only while in a
 * forward workflow state: clarifying → planning → gathering → evaluating →
 * synthesizing. This is the model-facing handle that actually drives the
 * state machine forward (research_start only opens the run; research_report
 * only finalizes from synthesizing). No-op or rejected in pause/terminal
 * states.
 */
const researchAdvanceDefinition: Tool = {
  name: RESEARCH_ADVANCE_TOOL_NAME,
  description:
    'Advance the research run to its next phase. Call this when you have finished the current phase: clarifying → planning → gathering → evaluating → synthesizing. Once you have written the report, call research_report(completed: true) instead.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const researchAdvanceExecutor: ToolExecutor = {
  async execute(
    _input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const state = researchModeTracker.state();
    if (state === 'idle') {
      return errorNoRun(RESEARCH_ADVANCE_TOOL_NAME);
    }
    if (state === 'complete') {
      return errorCompleted(RESEARCH_ADVANCE_TOOL_NAME);
    }

    // Forward-only phases advance to their natural successor.
    const advanceTo: Partial<Record<ResearchState, ResearchEvent>> = {
      clarifying: { type: 'plan' },
      planning: { type: 'search' },
      gathering: { type: 'evaluate' },
      evaluating: { type: 'synthesize' },
    };
    const event = advanceTo[state];
    if (!event) {
      return {
        id: crypto.randomUUID(),
        name: RESEARCH_ADVANCE_TOOL_NAME,
        result: JSON.stringify({
          advanced: false,
          state: researchModeTracker.state(),
          phase: researchModeTracker.phase(),
          query: researchModeTracker.query(),
          message: `Cannot advance from ${state}. ${
            state === 'synthesizing'
              ? 'Write the report and call research_report(completed: true).'
              : state === 'awaiting_input' || state === 'blocked'
                ? 'Call research_continue once the user unblocks it.'
                : ''
          }`,
          error_code: RESEARCH_ERROR_CODES.NO_ADVANCE,
        }),
        error: true,
      };
    }

    const changed = researchModeTracker.transition(event);
    if (changed) {
      const sessionId = context?.options.sessionId;
      if (sessionId) {
        await persistSnapshot(
          researchModeTracker as unknown as ModeTracker<string, string, unknown>,
          sessionId,
        );
      }
    }
    emitResearchUpdated(context?.options.sessionId);
    return {
      id: crypto.randomUUID(),
      name: RESEARCH_ADVANCE_TOOL_NAME,
      result: JSON.stringify({
        advanced: changed,
        state: researchModeTracker.state(),
        phase: researchModeTracker.phase(),
        query: researchModeTracker.query(),
        message: changed
          ? `Research advanced to ${researchModeTracker.state()}.`
          : 'Research could not advance (unexpected state).',
      }),
      error: changed ? false : true,
    };
  },
};

function errorInput(name: string, detail: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: JSON.stringify({
      error: `Invalid input: ${detail}`,
      error_code: RESEARCH_ERROR_CODES.INVALID_INPUT,
    }),
    error: true,
  };
}

function errorNoRun(name: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: JSON.stringify({
      error: 'No research run is active. Start one with research_start.',
      error_code: RESEARCH_ERROR_CODES.ALREADY_ACTIVE,
    }),
    error: true,
  };
}

function errorCompleted(name: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: JSON.stringify({
      error: 'The research run is already complete. Start a new one with research_start.',
      error_code: RESEARCH_ERROR_CODES.COMPLETE,
    }),
    error: true,
  };
}

/** ToolRegistration pairs injected by research mode (plan 423 §4, §Phase 3). */
export function getResearchTools(): Array<{ definition: Tool; executor: ToolExecutor }> {
  return [
    { definition: researchStartDefinition, executor: researchStartExecutor },
    { definition: researchReportDefinition, executor: researchReportExecutor },
    { definition: researchContinueDefinition, executor: researchContinueExecutor },
    { definition: researchAdvanceDefinition, executor: researchAdvanceExecutor },
    getResearchFanoutTool(),
  ];
}