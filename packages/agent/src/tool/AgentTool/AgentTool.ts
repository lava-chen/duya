/**
 * AgentTool - Tool for spawning sub-agents
 * Enhanced: extends BaseTool with full Tool interface
 */

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
import { sessionDb } from '../../ipc/db-client.js';
import { sendEvent } from '../../process/worker-protocol.js';
import { buildChatAgentProgressPayload, type AgentProgressPayloadMeta } from './agentLifecycleBridge.js';
import { backgroundAgentLifecycle } from '../../lifecycle/BackgroundAgentLifecycle.js';
import { logger } from '../../utils/logger.js';

export { formatAgentLine }

export const AGENT_TOOL_NAME = 'Agent'
export const LEGACY_AGENT_TOOL_NAME = 'Task'

export interface AgentToolInput {
  name?: string
  description?: string
  subagent_type?: string
  prompt: string
  run_in_background?: boolean
  isolation?: 'worktree'
  model?: string
}

export interface AgentToolResult {
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
  };
}

const recentBackgroundSpawns = new Map<string, BackgroundSpawnRecord>();

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function pruneRecentBackgroundSpawns(now: number): void {
  for (const [key, record] of recentBackgroundSpawns) {
    if (now - record.createdAt > BACKGROUND_SPAWN_TTL_MS) {
      recentBackgroundSpawns.delete(key);
    }
  }
}

export class AgentTool extends BaseTool {
  readonly name = AGENT_TOOL_NAME;
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
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description: 'Run the agent in an isolated git worktree',
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
          working_directory: context.options.workingDirectory ?? '',
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

        const backgroundResult: BackgroundSpawnRecord['result'] = {
          agentType: requestedAgentType,
          resolvedAgentType: agentDefinition.agentType,
          description: agentInput.description || agentInput.name,
          content: `[Agent launched in background: ${subAgentName}]`,
          sessionId: subAgentSessionId,
          taskId,
          agentId: taskId,
          outputFilePath: record.outputFilePath,
          background: true,
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
          toolUseContext: context,
          isAsync: true,
          model: agentInput.model,
          maxTurns: agentInput.maxTurns,
          availableTools: context.options.tools,
          description: agentInput.description || agentInput.name,
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
          }
        })


        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify(backgroundResult),
        };
      }

      const result = await runAgentSync({
        agentDefinition,
        promptMessages,
        toolUseContext: context,
        isAsync: false,
        model: agentInput.model,
        maxTurns: agentInput.maxTurns,
        availableTools: context.options.tools,
        description: agentInput.description || agentInput.name,
        onProgress,
        sessionId: subAgentSessionId,
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

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          agentType: requestedAgentType,
          resolvedAgentType: agentDefinition.agentType,
          description: agentInput.description || agentInput.name,
          content: resultText,
          sessionId: subAgentSessionId,
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

      const agentType = parsed.resolvedAgentType || parsed.agentType || 'Agent';
      const description = parsed.description || '';
      const content = parsed.content || '';
      const sessionId = parsed.sessionId || '';

      const header = description
        ? `${agentType} Agent: ${description}`
        : `${agentType} Agent`;

      const lines = content.split('\n');
      const previewLines = lines.length > 30
        ? lines.slice(0, 20).join('\n') + `\n\n[... ${lines.length - 20} more lines]`
        : content;

      const output = `[${header}]\n${sessionId ? `Session: ${sessionId}\n` : ''}\n${previewLines}`;

      return {
        type: 'markdown',
        content: output,
        metadata: { ...result.metadata, agentType, sessionId, lineCount: lines.length },
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
      const agentType = (obj.subagent_type as string) || 'Agent';
      if (obj.name) {
        return `${agentType}: ${obj.name}`;
      }
      const prompt = obj.prompt as string | undefined;
      if (prompt) {
        const preview = prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt;
        return `${agentType}: ${preview}`;
      }
    }
    return 'Agent';
  }
}

export const agentTool = new AgentTool();

export function getAgentToolDefinition(): { name: string; description: string; input_schema: Record<string, unknown> } {
  return agentTool.toTool();
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
