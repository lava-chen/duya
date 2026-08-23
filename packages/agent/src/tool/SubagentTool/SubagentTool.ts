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
import type { ToolResult, ToolUseContext, MessageContent } from '../../types.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';
import type { AgentDefinition } from './loadAgentsDir.js';
import { getBuiltInAgents } from './builtInAgents.js';
import { formatAgentLine, getPrompt } from './prompt.js';
import { runAgent, runAgentSync, type AgentProgressEvent } from './runAgent.js';
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
import {
  cleanupIfUnchanged,
  createAgentWorktree,
  type AgentWorktreeHandle,
} from '../../worktree/worktree-manager.js';

/** Wire shape of the optional worktree summary attached to tool results (plan 440). */
interface WorktreeSummary {
  path: string;
  branch: string;
  /** True when the tree still exists after the agent finished (dirty). */
  kept: boolean;
  /** True when the zero-change tree was removed automatically. */
  cleaned: boolean;
}

function toWorktreeSummary(
  handle: AgentWorktreeHandle,
  outcome: { removed: boolean; reason?: string },
): WorktreeSummary {
  return {
    path: handle.path,
    branch: handle.branch,
    kept: !outcome.removed,
    cleaned: outcome.removed,
  };
}

export { formatAgentLine }
export { SUBAGENT_TOOL_NAME, LEGACY_SUBAGENT_TOOL_NAME, VERIFICATION_AGENT_TYPE, ONE_SHOT_BUILTIN_AGENT_TYPES } from './constants.js';

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
}

export interface SubagentToolResult {
  agentId: string
  agentType: string
  content: Array<{ type: 'text'; text: string }>
  totalToolUseCount: number
  totalDurationMs: number
  totalTokens: number
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
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
  result: {
    agentType: string;
    resolvedAgentType: string;
    description?: string;
    content: string;
    sessionId: string;
    taskId: string;
    agentId: string;
    outputFilePath?: string;
    background: true;
    status: 'running';
    worktree?: { path: string; branch: string };
  };
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
 * Deliberately does NOT tell the model to block-wait via get_task_output:
 * the terminal <task-notification> (with the final result and the output-file
 * path) is delivered automatically, so waiting would double-receive the
 * result. A get_task_output snapshot (no timeout_ms) is fine for a status
 * check, never for blocking on this task. */
function formatSubagentStartedBackground(
  subagentId: string,
  agentType: string,
  description: string,
  continueParentWork: boolean,
): string {
  const guide = continueParentWork
    ? BACKGROUND_SUBAGENT_CONTINUE_PARENT_WORK
    : BACKGROUND_SUBAGENT_IDLE_NOTICE;
  return [
    `Subagent started in background.`,
    `subagent_id: ${subagentId}`,
    `type: ${agentType}`,
    `description: ${description}`,
    ``,
    `It runs independently of this session. When it completes you will be notified automatically with a <task-notification> containing the final result and the output-file path (Read it for the full transcript). Do not wait or poll for it — get_task_output is for a quick status snapshot (no timeout_ms), never for a blocking wait.`,
    ``,
    guide,
  ].join('\n');
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
        description: 'When running in the background, whether to automatically resume/wake the parent session when the sub-agent completes. Defaults to true.',
        default: true,
      },
      resume_from: {
        type: 'string',
        description: 'A subagent_id / session id to resume an existing sub-agent conversation instead of starting a new one.',
      },
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description:
          "Run the agent in an isolated git worktree (fresh base commit + dedicated branch) so concurrent agents can mutate files without conflicting. Costs setup time and disk per agent — pass it ONLY when multiple agents would otherwise write to the same files in parallel. A zero-change tree is removed automatically; a dirty tree is kept and its path is returned in the result.",
      },
      model: {
        type: 'string',
        description: 'Model to use for this agent (defaults to inherit from parent)',
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
    const agentInput = input as {
      prompt: string;
      subagent_type?: string;
      name?: string;
      description?: string;
      model?: string;
      maxTurns?: number;
      run_in_background?: boolean;
      isolation?: 'worktree';
    };

    if (!context) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'Agent tool requires context for execution' }),
        error: true,
      };
    }

    try {
      const agentDefinitions = context.options.agentDefinitions?.allAgents ?? [];
      const requestedAgentType = agentInput.subagent_type || 'general-purpose';
      const normalizedRequested = requestedAgentType.trim().toLowerCase();
      const canonicalRequestedType = agentTypeAliases[normalizedRequested] || requestedAgentType;
      const effectiveRunInBackground = agentInput.run_in_background !== false;
      const parentSessionId = context.options.sessionId;

      logger.info('[SubAgent] Agent tool invoked', {
        requestedAgentType,
        canonicalRequestedType,
        requestedRunInBackground: agentInput.run_in_background,
        effectiveRunInBackground,
        parentSessionId: context.options.sessionId,
        toolUseId: context.toolUseId,
        promptLength: agentInput.prompt?.length ?? 0,
        availableAgentTypes: agentDefinitions.map((def: AgentDefinition) => def.agentType),
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

      const subAgentName = agentInput.name || agentDefinition.agentType;
      if (effectiveRunInBackground && parentSessionId) {
        const now = Date.now();
        pruneRecentBackgroundSpawns(now);
        const promptHash = hashString(agentInput.prompt.trim());
        const spawnKeys = [
          `${parentSessionId}:tool:${context.toolUseId}`,
          `${parentSessionId}:semantic:${agentDefinition.agentType}:${subAgentName}:${promptHash}`,
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

      // plan 440: isolation:'worktree' — give this sub-agent a private git
      // worktree so it can mutate files without racing siblings or the
      // parent's working copy. Creation failure is surfaced as an explicit
      // error, never silently degraded: the caller asked for parallel-write
      // isolation, and dropping it would reintroduce exactly that conflict.
      let worktree: AgentWorktreeHandle | undefined;
      if (agentInput.isolation === 'worktree') {
        const repoDir = context.options.workingDirectory ?? process.cwd();
        try {
          worktree = await createAgentWorktree({
            repoDir,
            name: agentInput.name || agentDefinition.agentType,
          });
          logger.info('[SubAgent] worktree isolation enabled', {
            taskId: context.toolUseId,
            parentSessionId: context.options.sessionId,
            worktreePath: worktree.path,
            branch: worktree.branch,
          }, 'SubAgent')
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('[SubAgent] worktree creation failed', err as Error, {
            parentSessionId: context.options.sessionId,
            repoDir,
          }, 'SubAgent')
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: JSON.stringify({
              error: `isolation 'worktree' requested but failed to create one: ${message}`,
            }),
            error: true,
          };
        }
      }
      // Everything downstream (DB session record, runAgent tool cwd) points at
      // the worktree when isolation is active — see runAgent's use of
      // options.workingDirectory for every file/bash tool.
      const effectiveWorkingDirectory = worktree?.path ?? context.options.workingDirectory;
      const isolatedContext: ToolUseContext = worktree
        ? { ...context, options: { ...context.options, workingDirectory: effectiveWorkingDirectory } }
        : context;

      const promptMessages = [
        {
          role: 'user' as const,
          content: agentInput.prompt,
          timestamp: Date.now(),
        },
      ];

      const subAgentSessionId = crypto.randomUUID();
      try {
        await sessionDb.create({
          id: subAgentSessionId,
          title: `Sub: ${subAgentName}`,
          working_directory: effectiveWorkingDirectory ?? '',
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
              context.reportAgentProgress!({
                ...event,
                agentType: agentDefinition.agentType,
                agentName: agentInput.name,
                agentDescription: agentInput.description || agentInput.name,
                sessionId: subAgentSessionId,
              })
            }
          : undefined;

      if (effectiveRunInBackground) {
        const record = backgroundAgentLifecycle.register({
          taskId,
          parentSessionId: parentSessionId ?? '',
          subAgentSessionId,
          agentType: agentDefinition.agentType,
          agentName: subAgentName,
          description: agentInput.description || agentInput.name || subAgentName,
          abortController: new AbortController(),
        })

        logger.info('[SubAgent] background task registered', {
          taskId,
          parentSessionId,
          subAgentSessionId,
          agentType: agentDefinition.agentType,
          agentName: subAgentName,
          outputFilePath: record.outputFilePath,
        }, 'SubAgent')

        const userAsks = await getRecentUserAsks(parentSessionId ?? '');
        const continueParentWork = shouldContinueParentWork(
          userAsks,
          agentInput.description || agentInput.name || subAgentName,
          agentInput.prompt,
        );
        let spawnNotice = formatSubagentStartedBackground(
          taskId,
          agentDefinition.agentType,
          agentInput.description || agentInput.name || subAgentName,
          continueParentWork,
        );
        if (worktree) {
          spawnNotice += `\n\nworktree: ${worktree.path}\nbranch: ${worktree.branch}\nThis agent runs inside an isolated git worktree; its file changes do not touch the parent working copy.`;
        }
        const backgroundResult: BackgroundSpawnRecord['result'] = {
          agentType: requestedAgentType,
          resolvedAgentType: agentDefinition.agentType,
          description: agentInput.description || agentInput.name,
          content: spawnNotice,
          sessionId: subAgentSessionId,
          taskId,
          agentId: taskId,
          outputFilePath: record.outputFilePath,
          background: true,
          status: 'running',
          ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
        };
        if (parentSessionId) {
          const spawnRecord: BackgroundSpawnRecord = {
            createdAt: Date.now(),
            result: backgroundResult,
          };
          const promptHash = hashString(agentInput.prompt.trim());
          recentBackgroundSpawns.set(`${parentSessionId}:tool:${context.toolUseId}`, spawnRecord);
          recentBackgroundSpawns.set(
            `${parentSessionId}:semantic:${agentDefinition.agentType}:${subAgentName}:${promptHash}`,
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
          toolUseContext: isolatedContext,
          isAsync: true,
          model: agentInput.model,
          maxTurns: agentInput.maxTurns,
          availableTools: context.options.tools,
          description: agentInput.description || agentInput.name,
          agentId: taskId,
          onProgress,
          sessionId: subAgentSessionId,
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
            await sessionDb.update(subAgentSessionId, {
              status: snapshot?.status === 'completed' ? 'completed' : 'error',
              updated_at: Date.now(),
            })
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
            if (worktree) {
              // plan 440 auto-cleanup: drop a zero-change tree; keep and log
              // a dirty one so real work is never silently discarded.
              const outcome = await cleanupIfUnchanged(worktree).catch((err) => ({
                removed: false,
                reason: err instanceof Error ? err.message : String(err),
              }));
              logger.info('[SubAgent] background worktree cleanup', {
                taskId,
                subAgentSessionId,
                path: worktree.path,
                branch: worktree.branch,
                ...outcome,
              }, 'SubAgent')
            }
          }
        })


        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify(backgroundResult),
        };
      }

      // The agent may crash or be aborted mid-run — the worktree must be
      // cleaned up on that path too, not only on success. Capture the
      // failure and rethrow after the unconditional cleanup below so the
      // outer handler still produces the error result.
      let syncFailure: unknown;
      let result: Awaited<ReturnType<typeof runAgentSync>>;
      try {
        result = await runAgentSync({
          agentDefinition,
          promptMessages,
          toolUseContext: isolatedContext,
          isAsync: false,
          model: agentInput.model,
          maxTurns: agentInput.maxTurns,
          availableTools: context.options.tools,
          description: agentInput.description || agentInput.name,
          agentId: taskId,
          onProgress,
          sessionId: subAgentSessionId,
        });
      } catch (err) {
        syncFailure = err;
      }

      // The agent is done touching files — apply the plan 440 auto-cleanup
      // contract before reporting: zero-change trees vanish, dirty trees are
      // kept and their location reported back to the model. Runs on the
      // failure path as well so a crashed run never leaks its tree.
      let worktreeSummary: WorktreeSummary | undefined;
      if (worktree) {
        const outcome = await cleanupIfUnchanged(worktree).catch((err) => ({
          removed: false,
          reason: err instanceof Error ? err.message : String(err),
        }));
        worktreeSummary = toWorktreeSummary(worktree, outcome);
        logger.info('[SubAgent] foreground worktree cleanup', {
          subAgentSessionId,
          path: worktree.path,
          branch: worktree.branch,
          ...outcome,
        }, 'SubAgent')
      }

      if (syncFailure !== undefined) {
        throw syncFailure;
      }

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

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          agentType: requestedAgentType,
          resolvedAgentType: agentDefinition.agentType,
          description: agentInput.description || agentInput.name,
          content: resultText,
          sessionId: subAgentSessionId,
          ...(worktreeSummary ? { worktree: worktreeSummary } : {}),
        }),
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
        result: JSON.stringify({ error: `Agent execution failed: ${errorMessage}` }),
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
      const meta = `<subagent_meta>id=${sessionId}, type=${agentType}, turns=1</subagent_meta>`;
      const footer = `<subagent_result>\nsubagent_id: ${sessionId}\nsubagent_type: ${agentType}\nTo continue this subagent's conversation, use resume_from="${sessionId}"\n</subagent_result>`;
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

export function getSubagentToolDefinition(): { name: string; description: string; input_schema: Record<string, unknown> } {
  return subagentTool.toTool();
}

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
