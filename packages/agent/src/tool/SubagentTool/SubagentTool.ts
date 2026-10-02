/**
 * SubagentTool - Tool for spawning sub-agents
 *
 * Internally named `SubagentTool` so the LLM sees clearer intent
 * ("this spawns a sub-agent, not a top-level agent loop"). The wire
 * name is `'task'` (aligned to Grok's `task` tool); the legacy wire
 * name `'Agent'` is still accepted for backward compat with existing
 * session history and saved permission rules — see `SUBAGENT_TOOL_NAME`
 * and `LEGACY_SUBAGENT_TOOL_NAME` in `./constants.ts`.
 *
 * Enhanced: extends BaseTool with full Tool interface
 */

import { createHash } from 'node:crypto';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext, MessageContent, TokenUsage } from '../../types.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';
import type { AgentDefinition } from './loadAgentsDir.js';
import { getBuiltInAgents } from './builtInAgents.js';
import { formatAgentLine, getPrompt } from './prompt.js';
import { runAgent, runAgentSync, type AgentProgressEvent } from './runAgent.js';
import {
  VERDICT_CONTRACT,
  buildSubagentParentReport,
  captureGitFileChanges,
  diffFileChanges,
  parseModelVerdict,
  wantsVerdictContract,
} from '../task-verification.js';
import { sessionDb, messageDb } from '../../ipc/db-client.js';
import { sendEvent } from '../../process/worker-protocol.js';
import { buildChatAgentProgressPayload, type AgentProgressPayloadMeta } from './subagentLifecycleBridge.js';
import { backgroundAgentLifecycle } from '../../lifecycle/BackgroundAgentLifecycle.js';
import { logger } from '../../utils/logger.js';
import { SUBAGENT_TOOL_NAME } from './constants.js';
import {
  BACKGROUND_SUBAGENT_CONTINUE_PARENT_WORK,
  BACKGROUND_SUBAGENT_IDLE_NOTICE,
  shouldContinueParentWork,
} from './continueParentWork.js';
import { resolveResumeTarget } from './resumeAgent.js';
import { buildWorktreeSpawnNotice } from './forkSubagent.js';
import { createIsolatedWorktree, WorktreeError } from './worktree.js';
import {
  SUBAGENT_EFFORT_LEVELS,
  SUBAGENT_PERMISSION_MODES,
  normalizeEffort,
  normalizePermissionMode,
  normalizeToolOverlay,
  serializeSubagentResult,
  type SubagentToolResultPayload,
  type SubagentToolOverlay,
} from './subagentResult.js';
import type { PermissionMode } from '../../permissions/types.js';

export { formatAgentLine }
export { SUBAGENT_TOOL_NAME, LEGACY_SUBAGENT_TOOL_NAME, VERIFICATION_AGENT_TYPE, ONE_SHOT_BUILTIN_AGENT_TYPES } from './constants.js';

/**
 * LLM-facing parameter surface. Every field declared here is read in
 * `execute()` and threaded into the child run — plan 571 closed the three
 * declared-but-dead parameters (`auto_wake`, `resume_from`, `isolation`) and
 * added the four that were missing (`max_turns`, `effort`,
 * `permission_mode`, `tools`).
 */
export interface SubagentToolInput {
  name?: string
  description?: string
  subagent_type?: string
  prompt: string
  run_in_background?: boolean
  auto_wake?: boolean
  resume_from?: string
  isolation?: 'worktree'
  model?: string
  /** Cap on agentic turns for the child. Absent = uncapped (agent def wins). */
  max_turns?: number
  /** Thinking budget for the child's model invocation. */
  effort?: string
  /** Permission mode for the child's own tool gate. */
  permission_mode?: string
  /** Per-call overlay on top of the agent definition's tool list. */
  tools?: unknown
}

const agentTypeAliases: Record<string, string> = {
  explore: 'Explore',
  explorer: 'Explore',
  plan: 'Plan',
  research: 'Research',
  codereview: 'CodeReview',
  'code-review': 'CodeReview',
  verification: 'verification',
  'general-purpose': 'general-purpose',
  generalpurpose: 'general-purpose',
}

const BACKGROUND_SPAWN_TTL_MS = 10 * 60 * 1000;

interface BackgroundSpawnRecord {
  createdAt: number;
  result: SubagentToolResultPayload;
}

const recentBackgroundSpawns = new Map<string, BackgroundSpawnRecord>();

function hashString(value: string): string {
  // The previous hand-rolled 31-multiplier hash collided in practice
  // (two distinct prompts sharing a `:semantic:` spawn key suppressed
  // a legitimate second background spawn). SHA-256 truncated to 16
  // hex chars gives a 64-bit fingerprint, which is more than enough
  // collision resistance for an in-memory TTL map.
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function pruneRecentBackgroundSpawns(now: number): void {
  for (const [key, record] of recentBackgroundSpawns) {
    if (now - record.createdAt > BACKGROUND_SPAWN_TTL_MS) {
      recentBackgroundSpawns.delete(key);
    }
  }
}

function removeBackgroundSpawn(taskId: string): void {
  for (const [key, record] of recentBackgroundSpawns) {
    if (record.result.taskId === taskId) {
      recentBackgroundSpawns.delete(key);
    }
  }
}

/** Most recent parent user texts (oldest → newest), used to decide whether the
 * parent still has unfinished exec work besides the delegated child job. */
async function getRecentUserAsks(parentSessionId: string): Promise<string[]> {
  try {
    const rows = (await messageDb.getBySession(parentSessionId)) as
      | Array<{ role?: string; content?: unknown }>
      | undefined;
    if (!Array.isArray(rows)) return [];
    const asks: string[] = [];
    for (const row of rows) {
      if (row.role !== 'user') continue;
      const text = extractMessageText(row.content);
      if (text) asks.push(text);
    }
    return asks;
  } catch {
    return [];
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && typeof b.text === 'string') return b.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Render the model-facing background-spawn notice, aligned to Grok
 * `format_subagent_started_background`. When the parent still has unfinished
 * work we tell it to keep going; otherwise we tell it to yield the turn and
 * rely on the async completion notification instead of polling.
 *
 * Deliberately does NOT tell the model to wait via get_task_output: the tool
 * is snapshot-only, and the terminal <task-notification> (with the final
 * result and the output-file path) is delivered automatically, so waiting
 * would double-receive the result.
 *
 * Plan 571: the two footnotes below cover the cases where that automatic
 * delivery does not happen — `auto_wake: false` (no notification at all, so
 * the model must poll the file itself) and worktree isolation (the model has
 * to know where the child's edits actually live). */
function formatSubagentStartedBackground(
  subagentId: string,
  agentType: string,
  description: string,
  continueParentWork: boolean,
  extras: {
    autoWake: boolean;
    outputFilePath: string;
    resumed?: boolean;
    worktreeBranch?: string;
  },
): string {
  const guide = continueParentWork
    ? BACKGROUND_SUBAGENT_CONTINUE_PARENT_WORK
    : BACKGROUND_SUBAGENT_IDLE_NOTICE;
  const lines = [
    `Subagent started in background.`,
    `subagent_id: ${subagentId}`,
    `type: ${agentType}`,
    `description: ${description}`,
    ``,
  ];
  if (extras.resumed) {
    lines.push(`This run continues the sub-agent's earlier conversation; its history was replayed into the new turn.`);
    lines.push(``);
  }
  if (extras.autoWake) {
    lines.push(`It runs independently of this session. When it completes you will be notified automatically with a <task-notification> containing the final result and the output-file path (Read it for the full transcript). Do not wait or poll for it — get_task_output only takes a status/output snapshot; it never blocks. If the task looks stuck, use kill_task.`);
  } else {
    lines.push(`It runs independently of this session, and auto_wake is false: you will NOT be notified when it completes. Poll it yourself with get_task_output using task_id "${subagentId}"; the full transcript is at ${extras.outputFilePath}. Read that file for the complete output once the task reports a terminal status.`);
  }
  if (extras.worktreeBranch) {
    lines.push(``);
    lines.push(`It is working in an isolated git worktree on branch ${extras.worktreeBranch}. Its file changes do not touch this working copy — merge or cherry-pick the branch to adopt them.`);
  }
  lines.push(``, guide);
  return lines.join('\n');
}

/**
 * Validate `max_turns`. Non-positive, fractional, and non-numeric values are
 * dropped (the caller warns) rather than clamped: a silently-clamped cap
 * would look like the model asked for 5 turns and got 3.
 */
function normalizeMaxTurns(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

/**
 * Map the agent-side `TokenUsage` shape onto the receipt's `usage` contract.
 * Cache token fields are renamed to the `*_input_tokens` spelling the
 * renderer parser expects.
 */
function mapTokenUsage(usage: TokenUsage | undefined): SubagentToolResultPayload['usage'] | undefined {
  if (!usage) return undefined;
  const input = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  const output = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
  const mapped: NonNullable<SubagentToolResultPayload['usage']> = {
    input_tokens: input,
    output_tokens: output,
  };
  if (typeof usage.cache_creation_tokens === 'number' && usage.cache_creation_tokens > 0) {
    mapped.cache_creation_input_tokens = usage.cache_creation_tokens;
  }
  if (typeof usage.cache_hit_tokens === 'number' && usage.cache_hit_tokens > 0) {
    mapped.cache_read_input_tokens = usage.cache_hit_tokens;
  }
  return mapped;
}

export class SubagentTool extends BaseTool {
  readonly name = SUBAGENT_TOOL_NAME;
  readonly description = 'Launch a new agent to handle complex, multi-step tasks autonomously.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'A short name (3-5 words) for the agent task',
        maxLength: 40,
      },
      description: {
        type: 'string',
        description: 'A description of what the agent should do',
      },
      subagent_type: {
        type: 'string',
        description: 'The type of agent to spawn (e.g., "Explore", "Plan", "verification"). If omitted, uses the general-purpose agent.',
      },
      prompt: {
        type: 'string',
        description: 'The task description and context to give the agent',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run the agent in the background. Defaults to true; pass false only when the caller must wait for the result before continuing.',
        default: true,
      },
      auto_wake: {
        type: 'boolean',
        description: 'Background only. When false, the parent session is NOT resumed when the sub-agent completes — no <task-notification> is delivered. Read the result yourself with get_task_output using the output_file_path from this receipt. Defaults to true.',
        default: true,
      },
      resume_from: {
        type: 'string',
        description: 'A subagent_id returned by a previous task call. Continues that sub-agent\'s own conversation (its history is replayed into the new run) under the same session id, instead of briefing a fresh agent from scratch. Omit to start a new sub-agent.',
      },
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description: 'Set to "worktree" to run the agent in a fresh git worktree of the repository, so its file edits cannot touch the user\'s working copy. Requires a clean git working tree; the worktree path is reported in the result.',
      },
      model: {
        type: 'string',
        description: 'Model to use for this agent (defaults to inherit from parent)',
      },
      max_turns: {
        type: 'number',
        description: 'Maximum agentic turns for this agent. Omit to use the agent definition\'s own cap, or leave the loop uncapped when it has none.',
        minimum: 1,
      },
      effort: {
        type: 'string',
        enum: [...SUBAGENT_EFFORT_LEVELS],
        description: 'Thinking budget for this agent. "off" disables extended thinking; higher levels spend more tokens on reasoning. Omit to inherit the runtime default.',
      },
      permission_mode: {
        type: 'string',
        enum: [...SUBAGENT_PERMISSION_MODES],
        description: 'Permission mode for the sub-agent\'s own tool calls. "default" asks the user, "auto" auto-accepts low-risk actions, "bypassPermissions" runs unattended. Omit to use the default mode.',
      },
      tools: {
        type: 'object',
        properties: {
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keep only these tools (intersected with the agent definition\'s list).',
          },
          deny: {
            type: 'array',
            items: { type: 'string' },
            description: 'Remove these tools. Applied after allow, so deny wins.',
          },
        },
        additionalProperties: false,
        description: 'Per-call overlay on top of the agent definition\'s tool list. Agent-orchestration tools stay withheld either way.',
      },
    },
    required: ['prompt'],
  };

  get interruptBehavior(): ToolInterruptBehavior {
    return 'block';
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext
  ): Promise<ToolResult> {
    const agentInput = input as unknown as SubagentToolInput;

    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'Agent tool requires context for execution' }),
        error: true,
      };
    }

    // Plan 568: hoisted so the catch can attach it to the error result —
    // a failed agent's sub-session id is the watch-pane link.
    let subAgentSessionId: string | undefined;
    // Worktree branch name, surfaced in the receipt so the model can report
    // where its changes landed.
    let worktreeBranch: string | undefined;

    try {
      const agentDefinitions = context.options.agentDefinitions?.allAgents ?? [];
      const requestedAgentType = agentInput.subagent_type || 'general-purpose';
      const normalizedRequested = requestedAgentType.trim().toLowerCase();
      const canonicalRequestedType = agentTypeAliases[normalizedRequested] || requestedAgentType;
      const effectiveRunInBackground = agentInput.run_in_background !== false;
      const parentSessionId = context.options.sessionId;

      // ---- Plan 571: validate the parameters that used to be dead -------
      // `auto_wake` only means anything for a background run; for a
      // foreground run the model blocks on the result, so there is nothing
      // to wake and the value is recorded as-is.
      const autoWake = agentInput.auto_wake !== false;
      const maxTurns = normalizeMaxTurns(agentInput.max_turns);
      const effort = normalizeEffort(agentInput.effort);
      const permissionMode = normalizePermissionMode(agentInput.permission_mode) as PermissionMode | undefined;
      const toolOverlay: SubagentToolOverlay | undefined = normalizeToolOverlay(agentInput.tools);
      const warnings: string[] = [];

      if (agentInput.effort !== undefined && effort === undefined) {
        warnings.push(
          `effort "${String(agentInput.effort)}" is not a valid thinking level; ignored. Valid values: ${SUBAGENT_EFFORT_LEVELS.join(', ')}.`,
        );
      }
      if (agentInput.permission_mode !== undefined && permissionMode === undefined) {
        warnings.push(
          `permission_mode "${String(agentInput.permission_mode)}" is not valid; using the default permission mode. Valid values: ${SUBAGENT_PERMISSION_MODES.join(', ')}.`,
        );
      }
      if (agentInput.tools !== undefined && toolOverlay === undefined) {
        warnings.push('tools overlay was empty or malformed and has been ignored.');
      }
      if (maxTurns === undefined && agentInput.max_turns !== undefined) {
        warnings.push(`max_turns "${String(agentInput.max_turns)}" is not a positive number; ignored.`);
      }

      logger.info('[SubAgent] Agent tool invoked', {
        requestedAgentType,
        canonicalRequestedType,
        requestedRunInBackground: agentInput.run_in_background,
        effectiveRunInBackground,
        parentSessionId: context.options.sessionId,
        toolUseId: context.toolUseId,
        promptLength: agentInput.prompt?.length ?? 0,
        availableAgentTypes: agentDefinitions.map((def: AgentDefinition) => def.agentType),
        ...(agentInput.resume_from ? { resumeFrom: agentInput.resume_from } : {}),
        ...(agentInput.isolation ? { isolation: agentInput.isolation } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(toolOverlay ? { toolOverlay } : {}),
        ...(autoWake === false ? { autoWake } : {}),
      }, 'SubAgent')

      const agentDefinition = agentDefinitions.find((def: AgentDefinition) => {
        if (def.agentType === canonicalRequestedType) return true;
        return def.agentType.trim().toLowerCase() === normalizedRequested;
      });

      if (!agentDefinition) {
        logger.warn('[SubAgent] requested agent type not found', {
          requestedAgentType,
          canonicalRequestedType,
          availableAgentTypes: agentDefinitions.map((def: AgentDefinition) => def.agentType),
          parentSessionId: context.options.sessionId,
        }, 'SubAgent')
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({
            error: `Agent type "${requestedAgentType}" not found. Available types: ${agentDefinitions.map((d: AgentDefinition) => d.agentType).join(', ')}`,
          }),
          error: true,
        };
      }

      // Clamp defensively: the schema hints maxLength but the model may not
      // honor it, and this string flows into session titles and events.
      const subAgentName = (agentInput.name || agentDefinition.agentType).trim().slice(0, 80);
      // A resume is a deliberate follow-up turn on the same child, so the
      // duplicate-spawn guard (which exists to stop a retried spawn from
      // running the same background task twice) must not swallow it.
      if (effectiveRunInBackground && parentSessionId && !agentInput.resume_from) {
        const now = Date.now();
        pruneRecentBackgroundSpawns(now);
        const promptHash = hashString(agentInput.prompt.trim());
        // Semantic key intentionally excludes the model-invented `name`:
        // re-issuing the same task with a different whimsical name should
        // still be recognized as a duplicate spawn.
        const spawnKeys = [
          `${parentSessionId}:tool:${context.toolUseId}`,
          `${parentSessionId}:semantic:${agentDefinition.agentType}:${promptHash}`,
        ];
        const existingSpawn = spawnKeys
          .map((key) => recentBackgroundSpawns.get(key))
          .find((record): record is BackgroundSpawnRecord => Boolean(record));
        if (existingSpawn) {
          logger.warn('[SubAgent] duplicate background spawn suppressed', {
            parentSessionId,
            toolUseId: context.toolUseId,
            subAgentSessionId: existingSpawn.result.sessionId,
            taskId: existingSpawn.result.taskId,
          }, 'SubAgent')
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: JSON.stringify(existingSpawn.result),
          };
        }
      }

      // ---- Plan 571 3.1: `resume_from` reuses the child's own session ----
      // The history is prepended to `promptMessages` and the SAME
      // subAgentSessionId is reused below, so the child's transcript
      // continues instead of forking into a new conversation.
      const resumeTarget = agentInput.resume_from
        ? await resolveResumeTarget({
            resumeFrom: agentInput.resume_from,
            parentSessionId,
          })
        : undefined;

      if (resumeTarget && !resumeTarget.ok) {
        // Hard structured error (plan 571 decision): silently starting fresh
        // would hand back a "resumed" transcript that is actually empty, and
        // the model would report conclusions from work that never happened.
        logger.warn('[SubAgent] resume_from rejected', {
          code: resumeTarget.code,
          resumeFrom: agentInput.resume_from,
          parentSessionId,
        }, 'SubAgent')
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({ error: resumeTarget.message }),
          error: true,
        };
      }

      if (resumeTarget?.ok) {
        if (!agentInput.subagent_type) {
          warnings.push(
            `resume_from "${resumeTarget.sessionId}" was continued with the default general-purpose agent; pass subagent_type to keep the original agent's role.`,
          );
        }
        if (
          resumeTarget.workingDirectory &&
          context.options.workingDirectory &&
          resumeTarget.workingDirectory !== context.options.workingDirectory
        ) {
          warnings.push(
            `The resumed sub-agent originally ran in ${resumeTarget.workingDirectory}; this run uses the session's current working directory ${context.options.workingDirectory}.`,
          );
        }
        logger.info('[SubAgent] resuming sub-agent session', {
          resumeFrom: resumeTarget.sessionId,
          agentType: agentDefinition.agentType,
          historyMessages: resumeTarget.history.length,
          parentSessionId,
        }, 'SubAgent')
      }

      // ---- Plan 571 3.3: `isolation: 'worktree'` -------------------------
      // A worktree can only be created for a NEW child. Resuming an existing
      // session into a different working copy would silently change which
      // files the accumulated history refers to, so refuse the combination.
      if (agentInput.isolation === 'worktree' && resumeTarget?.ok) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({
            error: 'isolation: "worktree" cannot be combined with resume_from. Start a new sub-agent with isolation, or resume the existing one in the current working directory.',
          }),
          error: true,
        };
      }

      let childWorkingDirectory = context.options.workingDirectory;
      if (agentInput.isolation === 'worktree') {
        try {
          const worktree = await createIsolatedWorktree(
            context.options.workingDirectory ?? process.cwd(),
            subAgentName,
          );
          childWorkingDirectory = worktree.path;
          worktreeBranch = worktree.branch;
        } catch (err) {
          if (err instanceof WorktreeError) {
            // Not a repo / dirty tree / git refused: a specific sentence the
            // model can act on, never a stack trace.
            logger.warn('[SubAgent] worktree isolation failed', {
              code: err.code,
              parentSessionId,
            }, 'SubAgent')
            return {
              id: crypto.randomUUID(),
              name: this.name,
              result: JSON.stringify({ error: err.message }),
              error: true,
            };
          }
          throw err;
        }
      }

      // Plan 554: delegated work tasks (not read-only explorers) carry the
      // VERDICT completion contract so the parent gets a mechanical verdict
      // line instead of having to interpret prose.
      const verdictRequired = wantsVerdictContract(agentDefinition.agentType);
      const worktreeNotice =
        agentInput.isolation === 'worktree' && childWorkingDirectory
          ? `\n\n${buildWorktreeSpawnNotice(
              context.options.workingDirectory ?? process.cwd(),
              childWorkingDirectory,
              worktreeBranch ?? '(unknown branch)',
            )}`
          : '';
      const userMessage = {
        role: 'user' as const,
        content: verdictRequired
          ? `${agentInput.prompt}\n${VERDICT_CONTRACT}${worktreeNotice}`
          : `${agentInput.prompt}${worktreeNotice}`,
        timestamp: Date.now(),
      };
      const promptMessages = resumeTarget?.ok
        ? [...resumeTarget.history, userMessage]
        : [userMessage];

      // Best-effort file-change observation for this child run (plan 554):
      // a porcelain snapshot now, diffed against one taken when the child
      // finishes. Undefined outside a git repo — no observation then.
      // Diffed against the directory the child actually ran in, so worktree
      // isolation reports the child's edits and not the parent's.
      const fileChangeBefore = await captureGitFileChanges(childWorkingDirectory);

      // Resume keeps the original session (and its transcript); a new spawn
      // mints a fresh id and a fresh `chat_sessions` row.
      const isResume = resumeTarget?.ok === true;
      subAgentSessionId = isResume ? resumeTarget.sessionId : crypto.randomUUID();
      if (!isResume) {
        try {
          await sessionDb.create({
            id: subAgentSessionId,
            title: `Sub: ${subAgentName}`,
            working_directory: childWorkingDirectory ?? '',
            project_name: '',
            mode: 'code',
            provider_id: context.options.provider || 'env',
            generation: 0,
            parent_session_id: context.options.sessionId,
            agent_type: 'sub-agent',
            agent_name: subAgentName,
          });
          logger.info('[SubAgent] DB session created', {
            subAgentSessionId,
            parentSessionId: context.options.sessionId,
            agentType: agentDefinition.agentType,
            agentName: subAgentName,
          }, 'SubAgent')
        } catch (err) {
          logger.warn('[SubAgent] failed to create DB session', {
            subAgentSessionId,
            parentSessionId: context.options.sessionId,
            agentType: agentDefinition.agentType,
            err,
          }, 'SubAgent')
        }
      }

      // Shared helper: build a `chat:agent_progress` SSE payload for a
      // single sub-agent progress event. See agentLifecycleBridge for the
      // full wire-format contract (router -> SSE -> renderer remap).
      // taskId is declared here (synchronously, before payloadMeta) so the
      // closure below can capture it. For non-background invocations the
      // value is unused; the executor's pendingProgress is the only sink.
      const taskId = crypto.randomUUID()
      const payloadMeta: AgentProgressPayloadMeta = {
        parentSessionId: parentSessionId ?? '',
        subAgentSessionId,
        agentId: taskId,
        agentType: agentDefinition.agentType,
        agentName: agentInput.name,
        agentDescription: agentInput.description || agentInput.name,
      }

      // Background sub-agent progress is streamed directly to SSE while
      // terminal result ownership lives in BackgroundAgentLifecycle.
      const emitLiveProgress = (event: AgentProgressEvent) => {
        if (!parentSessionId) return
        try {
          sendEvent(buildChatAgentProgressPayload(event, payloadMeta))
        } catch (err) {
          logger.warn('[SubAgent] failed to emit live agent_progress', {
            taskId,
            eventType: event.type,
            err,
          }, 'SubAgent')
        }
      }

      const onProgress = effectiveRunInBackground
        ? emitLiveProgress
        : context.reportAgentProgress
          ? (event: AgentProgressEvent) => {
              // Plan 571: the 5s keepalive carries no model output, so it must
              // not enter the model-facing progress callback (whose event
              // union is the shared `@duya/ai` contract and has no liveness
              // member) — and must not be typed as `thinking` to squeeze it
              // in. It goes straight to the same `chat:agent_progress` wire
              // event the background path uses, so the renderer can render a
              // liveness indicator without the text reaching the transcript
              // projection.
              if (event.type === 'heartbeat') {
                emitLiveProgress(event)
                return
              }
              // `type` is destructured into its own binding on purpose: an
              // object spread of a narrowed discriminated union widens `type`
              // back to the full union, which would re-admit 'heartbeat'.
              const { type: eventType, ...eventRest } = event
              context.reportAgentProgress!({
                ...eventRest,
                type: eventType,
                agentType: agentDefinition.agentType,
                agentName: agentInput.name,
                agentDescription: agentInput.description || agentInput.name,
                sessionId: subAgentSessionId,
              })
            }
          : undefined;

      if (effectiveRunInBackground) {
        // The lifecycle's controller is the child's cancel handle: it is what
        // `kill_task` and the sub-agent panel's stop button (via the
        // `subagent:kill` worker command) abort, and `runAgent` listens on it.
        const taskAbortController = new AbortController();
        const record = backgroundAgentLifecycle.register({
          taskId,
          parentSessionId: parentSessionId ?? '',
          subAgentSessionId,
          agentType: agentDefinition.agentType,
          agentName: subAgentName,
          description: agentInput.description || agentInput.name || subAgentName,
          abortController: taskAbortController,
          autoWake,
        })

        logger.info('[SubAgent] background task registered', {
          taskId,
          parentSessionId,
          subAgentSessionId,
          agentType: agentDefinition.agentType,
          agentName: subAgentName,
          outputFilePath: record.outputFilePath,
          autoWake,
        }, 'SubAgent')

        const userAsks = await getRecentUserAsks(parentSessionId ?? '');
        const continueParentWork = shouldContinueParentWork(
          userAsks,
          agentInput.description || agentInput.name || subAgentName,
          agentInput.prompt,
        );
        const spawnNotice = formatSubagentStartedBackground(
          taskId,
          agentDefinition.agentType,
          agentInput.description || agentInput.name || subAgentName,
          continueParentWork,
          {
            autoWake,
            outputFilePath: record.outputFilePath,
            ...(isResume ? { resumed: true } : {}),
            ...(worktreeBranch ? { worktreeBranch } : {}),
          },
        );
        const backgroundResult = serializeSubagentResult({
          status: 'running',
          agentType: requestedAgentType,
          resolvedAgentType: agentDefinition.agentType,
          ...(agentInput.description || agentInput.name
            ? { description: agentInput.description || agentInput.name }
            : {}),
          content: spawnNotice,
          sessionId: subAgentSessionId,
          taskId,
          agentId: taskId,
          outputFilePath: record.outputFilePath,
          background: true,
          workingDirectory: childWorkingDirectory,
          ...(agentInput.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
        if (parentSessionId) {
          const spawnRecord: BackgroundSpawnRecord = {
            createdAt: Date.now(),
            result: JSON.parse(backgroundResult) as SubagentToolResultPayload,
          };
          const promptHash = hashString(agentInput.prompt.trim());
          recentBackgroundSpawns.set(`${parentSessionId}:tool:${context.toolUseId}`, spawnRecord);
          recentBackgroundSpawns.set(
            `${parentSessionId}:semantic:${agentDefinition.agentType}:${promptHash}`,
            spawnRecord
          );
        }

        // Emit a 'started' progress event synchronously so the UI can grab
        // subAgentSessionId at t=0 instead of waiting for the first real
        // progress event. Mirrors the emitTerminalProgress() path.
        if (parentSessionId) {
          try {
            sendEvent(buildChatAgentProgressPayload({ type: 'started', agentId: taskId }, payloadMeta))
          } catch (err) {
            logger.warn('[SubAgent] failed to emit spawn agent_progress', { taskId, err }, 'SubAgent')
          }
        }

        const agentGenerator = runAgent({
          agentDefinition,
          promptMessages,
          toolUseContext: context,
          isAsync: true,
          model: agentInput.model,
          maxTurns,
          availableTools: context.options.tools,
          description: agentInput.description || agentInput.name,
          agentId: taskId,
          onProgress,
          sessionId: subAgentSessionId,
          ...(effort ? { effort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(toolOverlay ? { toolOverlay } : {}),
          ...(childWorkingDirectory ? { workingDirectory: childWorkingDirectory } : {}),
          abortController: taskAbortController,
        }) as AsyncGenerator<unknown, void>;

        logger.info('[SubAgent] background run scheduled', {
          taskId,
          subAgentSessionId,
          agentType: agentDefinition.agentType,
        }, 'SubAgent')

        void backgroundAgentLifecycle.run(taskId, agentGenerator).finally(async () => {
          const snapshot = backgroundAgentLifecycle.getSnapshot(taskId)
          logger.info('[SubAgent] background run finalized', {
            taskId,
            subAgentSessionId,
            status: snapshot?.status,
            error: snapshot?.error,
          }, 'SubAgent')
          try {
            // Plan 568: subAgentSessionId is `string | undefined` since the
            // hoist — it is always assigned by here, but the closure loses
            // the narrowing, so guard before the DB write.
            if (subAgentSessionId !== undefined) {
              await sessionDb.update(subAgentSessionId, {
                status: snapshot?.status === 'completed' ? 'completed' : 'error',
                updated_at: Date.now(),
              });
            }
          } catch (err) {
            logger.warn('[SubAgent] failed to update session status', {
              taskId,
              subAgentSessionId,
              err,
            }, 'SubAgent')
          } finally {
            // The terminal notification is already durable in the queue. The
            // in-memory lifecycle record is no longer needed after DB status
            // persistence and would otherwise accumulate for the process life.
            backgroundAgentLifecycle.markDrained([taskId])
            removeBackgroundSpawn(taskId)
          }
        })


        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: backgroundResult,
        };
      }

      const result = await runAgentSync({
        agentDefinition,
        promptMessages,
        toolUseContext: context,
        isAsync: false,
        model: agentInput.model,
        maxTurns,
        availableTools: context.options.tools,
        description: agentInput.description || agentInput.name,
        agentId: taskId,
        onProgress,
        sessionId: subAgentSessionId,
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(toolOverlay ? { toolOverlay } : {}),
        ...(childWorkingDirectory ? { workingDirectory: childWorkingDirectory } : {}),
      });

      try {
        let hasError = false;
        if (typeof result.content !== 'string' && Array.isArray(result.content)) {
          for (const block of result.content) {
            if (block.type === 'text' && 'text' in block && typeof (block as { text: string }).text === 'string') {
              if ((block as { text: string }).text.includes('[Error')) {
                hasError = true;
                break;
              }
            }
          }
        }
        await sessionDb.update(subAgentSessionId, {
          status: hasError ? 'error' : 'completed',
          updated_at: Date.now(),
        });
      } catch (err) {
        logger.warn('[SubAgent] failed to update foreground session status', {
          subAgentSessionId,
          err,
        }, 'SubAgent')
      }

      let resultText = '';
      if (typeof result.content === 'string') {
        resultText = result.content;
      } else if (Array.isArray(result.content)) {
        const textParts: string[] = [];
        for (const block of result.content) {
          if (typeof block === 'string') {
            textParts.push(block);
          } else if (block && typeof block === 'object') {
            if ('text' in block && typeof block.text === 'string') {
              textParts.push(block.text);
            } else if ('thinking' in block && typeof block.thinking === 'string') {
              textParts.push(`[Thinking: ${block.thinking}]`);
            } else if (block.type === 'tool_use' && 'name' in block) {
              textParts.push(`[Tool: ${(block as { name: string }).name}]`);
            } else if (block.type === 'tool_result') {
              const tr = block as { content?: string | MessageContent[] };
              if (typeof tr.content === 'string') {
                textParts.push(tr.content);
              } else if (Array.isArray(tr.content)) {
                for (const nested of tr.content) {
                  if (typeof nested === 'string') {
                    textParts.push(nested);
                  } else if (nested && typeof nested === 'object' && 'text' in nested) {
                    textParts.push((nested as { text: string }).text);
                  }
                }
              }
            }
          }
        }
        resultText = textParts.join('\n');
      } else {
        resultText = String(result.content);
      }

      // Plan 554: attach the mechanical parent report — parsed verdict plus
      // the best-effort file-change diff — so the parent model reads the
      // facts alongside the child's prose.
      const verdict = verdictRequired ? parseModelVerdict(resultText) : undefined;
      // Snapshot the directory the child actually ran in, so a worktree-isolated
      // run reports its own edits instead of the untouched parent checkout.
      const fileChange = diffFileChanges(
        fileChangeBefore,
        await captureGitFileChanges(childWorkingDirectory),
      );
      const parentReport = buildSubagentParentReport({ verdict, fileChange });
      const finalContent = parentReport ? `${resultText}\n\n${parentReport}` : resultText;

      // Plan 571: the completion receipt is the same typed contract as every
      // other exit path. `runAgent` stamps the counters it accumulated onto
      // the message metadata, so the model gets real numbers instead of the
      // renderer having to guess them.
      const resultMetadata = (result.metadata ?? {}) as Record<string, unknown>;
      const totalToolUseCount = typeof resultMetadata.agentToolCallCount === 'number'
        ? resultMetadata.agentToolCallCount
        : 0;
      const totalDurationMs = typeof resultMetadata.agentDurationMs === 'number'
        ? resultMetadata.agentDurationMs
        : 0;
      const runFailed = typeof resultMetadata.agentError === 'string' && resultMetadata.agentError.trim() !== '';
      const usage = mapTokenUsage(result.tokenUsage);

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: serializeSubagentResult({
          status: runFailed ? 'failed' : 'completed',
          agentType: requestedAgentType,
          resolvedAgentType: agentDefinition.agentType,
          ...(agentInput.description || agentInput.name
            ? { description: agentInput.description || agentInput.name }
            : {}),
          content: finalContent,
          sessionId: subAgentSessionId,
          taskId,
          agentId: taskId,
          background: false,
          totalToolUseCount,
          totalDurationMs,
          totalTokens: usage
            ? usage.input_tokens + usage.output_tokens
            : 0,
          ...(usage ? { usage } : {}),
          workingDirectory: childWorkingDirectory,
          ...(agentInput.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
          ...(warnings.length ? { warnings } : {}),
          ...(runFailed ? { error: String(resultMetadata.agentError) } : {}),
        }),
        ...(runFailed ? { error: true } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[SubAgent] Agent tool execution failed', error as Error, {
        message: errorMessage,
        parentSessionId: context?.options.sessionId,
      }, 'SubAgent')
      return {
        id: crypto.randomUUID(),
        name: this.name,
        // Plan 568: the sub-session id rides along on failures too — the
        // workflow runtime journals it so the agent chip still opens the
        // watch pane for a failed run.
        result: JSON.stringify({
          error: `Agent execution failed: ${errorMessage}`,
          ...(subAgentSessionId !== undefined ? { sessionId: subAgentSessionId } : {}),
        }),
        error: true,
      };
    }
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      try {
        const parsed = JSON.parse(result.result);
        return {
          type: 'error',
          content: parsed.error || result.result,
          metadata: result.metadata,
        };
      } catch {
        return {
          type: 'error',
          content: result.result,
          metadata: result.metadata,
        };
      }
    }

    try {
      const parsed = JSON.parse(result.result);
      if (parsed.error) {
        return { type: 'error', content: parsed.error, metadata: result.metadata };
      }

      // Background spawn returns a running notice (not a completion block).
      // Render its structured spawn text verbatim — no completion meta/footer.
      if (parsed.status === 'running' || parsed.background === true) {
        return {
          type: 'markdown',
          content: parsed.content || 'Background subagent started.',
          metadata: {
            ...result.metadata,
            agentType: parsed.resolvedAgentType || parsed.agentType || 'task',
            sessionId: parsed.sessionId || '',
          },
        };
      }

      const agentType = parsed.resolvedAgentType || parsed.agentType || 'task';
      const content = parsed.content || '';
      const sessionId = parsed.sessionId || '';

      // Aligned to Grok SubagentCompletedOutput.to_model_text(): inline the
      // full output verbatim (no preview truncation) plus a metadata tag and
      // a resume footer, so the model can continue the subagent later.
      //
      // Plan 571: the meta tag now carries the real counters from the receipt
      // (it used to hardcode `turns=1`), and the worktree path is surfaced
      // so the model can tell the user where the child's edits live.
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      const metaParts = [
        `id=${sessionId}`,
        `type=${agentType}`,
        `tools=${parsed.totalToolUseCount ?? 0}`,
        `duration_ms=${parsed.totalDurationMs ?? 0}`,
      ];
      if (parsed.totalTokens) metaParts.push(`tokens=${parsed.totalTokens}`);
      if (parsed.workingDirectory) metaParts.push(`cwd=${parsed.workingDirectory}`);
      const meta = `<subagent_meta>${metaParts.join(', ')}</subagent_meta>`;

      const footerLines = [
        '<subagent_result>',
        `subagent_id: ${sessionId}`,
        `subagent_type: ${agentType}`,
        `To continue this subagent's conversation (its history is preserved), use resume_from="${sessionId}"`,
      ];
      if (parsed.isolation === 'worktree') {
        footerLines.push(
          `This run was isolated: its file changes are in the git worktree at ${parsed.workingDirectory || '(unknown path)'} and do not affect the session's working directory. Merge or cherry-pick that worktree's branch to adopt them.`,
        );
      }
      for (const warning of warnings) {
        footerLines.push(`Warning: ${warning}`);
      }
      footerLines.push('</subagent_result>');
      const footer = footerLines.join('\n');
      const output = `${content}\n\n${meta}\n\n${footer}`;

      return {
        type: 'markdown',
        content: output,
        metadata: { ...result.metadata, agentType, sessionId, lineCount: content.split('\n').length },
      };
    } catch {
      return {
        type: 'text',
        content: result.result,
        metadata: result.metadata,
      };
    }
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const agentType = (obj.subagent_type as string) || 'task';
      if (obj.name) {
        return `${agentType}: ${obj.name}`;
      }
      const prompt = obj.prompt as string | undefined;
      if (prompt) {
        const preview = prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt;
        return `${agentType}: ${preview}`;
      }
    }
    return 'task';
  }
}

export const subagentTool = new SubagentTool();

export function getAgentDefinitions(): AgentDefinition[] {
  return getBuiltInAgents();
}

export function formatAgentLineForPrompt(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent;
  const hasAllowlist = tools && tools.length > 0;
  const hasDenylist = disallowedTools && disallowedTools.length > 0;

  let toolsDescription: string;
  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools);
    const effectiveTools = tools.filter(t => !denySet.has(t));
    if (effectiveTools.length === 0) {
      toolsDescription = 'None';
    } else {
      toolsDescription = effectiveTools.join(', ');
    }
  } else if (hasAllowlist) {
    toolsDescription = tools.join(', ');
  } else if (hasDenylist) {
    toolsDescription = `All tools except ${disallowedTools.join(', ')}`;
  } else {
    toolsDescription = 'All tools';
  }

  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`;
}

export { getPrompt }
