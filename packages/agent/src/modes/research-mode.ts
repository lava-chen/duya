/**
 * researchMode — orchestrator-paradigm ModeModifier for Deep Research.
 *
 * Research mode is a multi-stage orchestrator (plan → clarification →
 * iteration → synthesis) that takes over the entire stream. It cannot
 * be expressed as a modifier on the agent tool loop, so it uses the
 * `orchestrator` field of {@link ModeModifier} (Phase 1.5 of plan 224).
 *
 * This file is a thin adapter that:
 *   1. Declares the {@link ModeModifier} metadata (id / kind / exclusiveWith / display)
 *   2. Wires `orchestrator.execute` to the existing {@link ResearchMode} class
 *   3. Builds the legacy {@link ModeContext} from the new {@link OrchestratorDeps}
 *
 * The ResearchMode class and its Orchestrator internals are unchanged —
 * only the registration and dispatch path changes (from `ModeRegistry.register`
 * to `modeModifierRegistry.register`).
 */

import { ResearchMode } from './research-mode/index.js';
import {
  resolveResearchClarificationRequest,
  rejectResearchClarificationRequest,
} from './research-mode/index.js';
import { buildResearchRunDB } from '../session/researchRunDb.js';
import { logger } from '../utils/logger.js';
import type {
  ModeModifier,
  ModeModifierContext,
  ModeContext,
  OrchestratorDeps,
  SSEEvent,
} from './types.js';

/**
 * Active ResearchMode instance — tracked so external code (e.g.
 * clarification resolution via IPC) can reach the running orchestrator
 * through {@link resolveActiveResearchClarification}.
 *
 * The instance also registers pending clarifications into the
 * module-level `pendingResearchClarifications` map (see
 * `research-mode/index.ts`), so this variable is only needed for
 * instance-level `resolveClarification` / `rejectClarification` calls
 * that clear the instance's `latestClarificationRequestId` tracker.
 */
let activeResearchMode: ResearchMode | null = null;

/**
 * Resolve a pending research clarification request. Tries the active
 * ResearchMode instance first (so its `latestClarificationRequestId`
 * tracker is cleared), then falls back to the module-level pending map.
 *
 * Called by `agent-process-entry.ts` when the renderer answers a
 * clarification question via IPC.
 */
export function resolveActiveResearchClarification(
  requestId: string,
  answers: Record<string, string>,
): boolean {
  if (activeResearchMode?.resolveClarification(requestId, answers)) {
    return true;
  }
  return resolveResearchClarificationRequest(requestId, answers);
}

/**
 * Reject a pending research clarification request. Same lookup order
 * as {@link resolveActiveResearchClarification}.
 */
export function rejectActiveResearchClarification(
  requestId: string,
  error: Error,
): boolean {
  if (activeResearchMode?.rejectClarification(requestId, error)) {
    return true;
  }
  return rejectResearchClarificationRequest(requestId, error);
}

/**
 * The Research mode modifier. Registered in `modes/index.ts` via
 * `modeModifierRegistry.register(researchMode)`.
 *
 * `exclusiveWith: ['plan-task']` — research and plan-task are both
 * per-message modes that cannot compose (plan-task is read-only,
 * research needs write access to run DB). Research composes with
 * conductor (research-mode orchestrator + conductor canvas tools).
 */
export const researchMode: ModeModifier = {
  id: 'research',
  kind: 'message',
  exclusiveWith: ['plan-task'],
  display: { label: 'Deep Research', icon: 'Telescope' },

  orchestrator: {
    execute: async function* (
      query: string,
      _ctx: ModeModifierContext,
      deps: OrchestratorDeps,
    ): AsyncGenerator<SSEEvent, void, unknown> {
      // Research mode depends on a chat session for run tracking and
      // report persistence. Fail fast in contexts without one (CLI /
      // standalone harness) instead of letting the orchestrator run,
      // produce a report the user can't retrieve, and silently return
      // an empty `done`.
      if (!deps.sessionId) {
        logger.warn('[researchMode] No sessionId; refusing to start');
        yield {
          type: 'error',
          data: 'Research mode requires an active chat session (sessionId is missing)',
        } as SSEEvent;
        return;
      }

      const mode = new ResearchMode();
      activeResearchMode = mode;
      try {
        const legacyCtx = await buildLegacyModeContext(query, deps);
        yield* mode.execute(query, legacyCtx);
      } finally {
        activeResearchMode = null;
      }
    },
  },
};

/**
 * Build the legacy {@link ModeContext} expected by {@link ResearchMode.execute}
 * from the new {@link OrchestratorDeps}.
 *
 * This is a pure adapter — it does not modify the deps, only projects
 * them into the shape ResearchMode was written against. Once ResearchMode
 * is refactored to accept {@link OrchestratorDeps} directly (out of scope
 * for plan 224), this adapter can be deleted.
 */
async function buildLegacyModeContext(
  query: string,
  deps: OrchestratorDeps,
): Promise<ModeContext> {
  const { _researchRunId, runDB, persistState } = await buildResearchRunDB(
    deps.sessionId,
    query,
  );

  const toolExecute: ModeContext['toolExecute'] = (name, input) =>
    deps.toolRegistry.execute(name, input, deps.workingDirectory).then((r) => {
      if (!r) throw new Error(`Tool not found: ${name}`);
      return r;
    });

  const toolExecuteConcurrent: ModeContext['toolExecuteConcurrent'] =
    async function* (calls) {
      const batchSize = 5;
      for (let i = 0; i < calls.length; i += batchSize) {
        const batch = calls.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((c) =>
            deps.toolRegistry
              .execute(c.name, c.input, undefined)
              .then((r) => {
                if (!r) throw new Error(`Tool not found: ${c.name}`);
                return r;
              }),
          ),
        );
        for (const r of results) yield r;
      }
    };

  return {
    llmClient: deps.llmClient,
    abortController: deps.abortController,
    sessionId: deps.sessionId,
    workingDirectory: deps.workingDirectory,
    researchMemory: deps.researchMemory,
    _researchRunId,
    toolExecute,
    toolExecuteConcurrent,
    persistState,
    runDB,
  };
}
