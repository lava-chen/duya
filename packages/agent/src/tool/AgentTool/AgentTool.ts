/**
 * AgentTool - Tool for spawning sub-agents
 * Enhanced: extends BaseTool with full Tool interface
 */

import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext, MessageContent, Message } from '../../types.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
} from '../types.js';
import type { AgentDefinition } from './loadAgentsDir.js';
import { getBuiltInAgents } from './builtInAgents.js';
import { formatAgentLine, getPrompt } from './prompt.js';
import { runAgent, runAgentSync, type AgentProgressEvent } from './runAgent.js';
import { backgroundTaskRegistry, type BackgroundTaskResult } from './BackgroundTaskRegistry.js';
import { sessionDb, messageDb } from '../../ipc/db-client.js';
import { sendEvent } from '../../process/worker-protocol.js';

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
        description: 'Whether to run the agent in the background',
        default: false,
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

      const agentDefinition = agentDefinitions.find((def: AgentDefinition) => {
        if (def.agentType === canonicalRequestedType) return true;
        return def.agentType.trim().toLowerCase() === normalizedRequested;
      });

      if (!agentDefinition) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({
            error: `Agent type "${requestedAgentType}" not found. Available types: ${agentDefinitions.map((d: AgentDefinition) => d.agentType).join(', ')}`,
          }),
          error: true,
        };
      }

      const promptMessages = [
        {
          role: 'user' as const,
          content: agentInput.prompt,
          timestamp: Date.now(),
        },
      ];

      const subAgentSessionId = crypto.randomUUID();
      const subAgentName = agentInput.name || agentDefinition.agentType;
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
        await messageDb.add({
          id: crypto.randomUUID(),
          session_id: subAgentSessionId,
          role: 'user',
          content: agentInput.prompt,
          msg_type: 'text',
        });
      } catch (err) {
        console.warn('[AgentTool] Failed to create sub-agent session in DB:', err);
      }

      const onProgress = context.reportAgentProgress
        ? (event: AgentProgressEvent) => {
            context.reportAgentProgress!({
              ...event,
              agentType: agentDefinition.agentType,
              agentName: agentInput.name,
              agentDescription: agentInput.description || agentInput.name,
              sessionId: subAgentSessionId,
            });
          }
        : undefined;

      if (agentInput.run_in_background) {
        const startTime = Date.now()
        const taskId = crypto.randomUUID()

        backgroundTaskRegistry.register({
          taskId,
          sessionId: subAgentSessionId,
          agentType: agentDefinition.agentType,
          agentName: agentInput.name,
          status: 'running',
          startedAt: Date.now(),
          onProgress,
        })

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
        });

        (async () => {
          const parentSessionId = context.options.sessionId
          if (!parentSessionId) return
          const emitTerminalProgress = (event: AgentProgressEvent) => {
            // Forward the sub-agent's terminal progress event directly to the
            // worker stdout so router.ts can stream it to the parent SSE client.
            // The reportAgentProgress path buffers into pendingProgress which is
            // never drained once the parent agent's LLM stream has already
            // emitted 'done' — so the parent's UI would stay stuck on
            // "正在运行..." until manual reload.
            try {
              sendEvent({
                type: 'chat:agent_progress',
                sessionId: parentSessionId,
                agentEventType: event.type,
                agentId: event.agentId,
                agentType: agentDefinition.agentType,
                agentName: agentInput.name,
                agentDescription: agentInput.description || agentInput.name,
                agentSessionId: subAgentSessionId,
                ...(event.duration !== undefined ? { duration: event.duration } : {}),
                ...(event.data !== undefined ? { data: event.data } : {}),
              })
            } catch (err) {
              console.warn('[AgentTool] Failed to emit terminal agent_progress:', err)
            }
            onProgress?.(event)
          }

          try {
            let lastMessage: Message | undefined
            for await (const message of agentGenerator) {
              lastMessage = message
            }
            try {
              await sessionDb.update(subAgentSessionId, {
                status: 'completed',
                updated_at: Date.now(),
              })
            } catch (err) {
              console.warn('[AgentTool] Failed to update sub-agent session status:', err)
            }

            if (lastMessage) {
              const content = Array.isArray(lastMessage.content)
                ? lastMessage.content.filter(
                    (b): b is { type: 'text'; text: string } =>
                      b.type === 'text' && typeof (b as { text: string }).text === 'string'
                  )
                : typeof lastMessage.content === 'string'
                  ? [{ type: 'text' as const, text: lastMessage.content }]
                  : [{ type: 'text' as const, text: String(lastMessage.content) }]

              const metadata = (lastMessage as { metadata?: Record<string, unknown> }).metadata || {}
              const result: BackgroundTaskResult = {
                content,
                totalTokens: 0,
                totalDurationMs: (metadata.agentDurationMs as number) || 0,
                totalToolUseCount: (metadata.agentToolCallCount as number) || 0,
              }
              backgroundTaskRegistry.complete(taskId, result)
            } else {
              backgroundTaskRegistry.complete(taskId, {
                content: [{ type: 'text', text: `[Agent ${agentDefinition.agentType}] completed with no output.` }],
                totalTokens: 0,
                totalDurationMs: Date.now() - startTime,
                totalToolUseCount: 0,
              })
            }

            emitTerminalProgress({
              type: 'done',
              duration: Date.now() - startTime,
              agentId: taskId,
            })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Unknown error'
            backgroundTaskRegistry.fail(taskId, errMsg)
            emitTerminalProgress({
              type: 'error',
              data: errMsg,
              agentId: taskId,
            })
          }
        })();

        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({
            agentType: requestedAgentType,
            resolvedAgentType: agentDefinition.agentType,
            description: agentInput.description || agentInput.name,
            content: `[Agent launched in background: ${subAgentName}]`,
            sessionId: subAgentSessionId,
            taskId,
            background: true,
          }),
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
        console.warn('[AgentTool] Failed to update sub-agent session status:', err);
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
