import { BaseTool } from '../BaseTool.js';
import type {
  RenderedToolMessage,
  ToolInterruptBehavior,
  ToolResult,
  ToolUseContext,
} from '../contracts/tool.js';
import { SUBAGENT_TOOL_NAME } from './constants.js';
import { SUBAGENT_EFFORT_LEVELS, SUBAGENT_PERMISSION_MODES } from './subagentResult.js';

/**
 * The Capability owns the model-visible contract and forwards an invocation
 * through an injected port. The execution context is intentionally opaque:
 * the host adapter projects only the fields it needs, without copying the
 * Agent package's full ToolUseContext into this package.
 */
export interface SubagentToolDispatchPort {
  execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: unknown,
  ): Promise<ToolResult>;
}

/** Model-facing arguments accepted by the legacy `task` wire tool. */
export interface SubagentToolInput {
  name?: string;
  description?: string;
  subagent_type?: string;
  prompt: string;
  run_in_background?: boolean;
  auto_wake?: boolean;
  resume_from?: string;
  isolation?: 'worktree';
  model?: string;
  max_turns?: number;
  effort?: string;
  permission_mode?: string;
  tools?: unknown;
}

export class SubagentTool extends BaseTool {
  constructor(private readonly dispatch: SubagentToolDispatchPort) {
    super();
  }

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
        description: 'Whether to run in the background. Defaults to true; pass false only when the caller must wait for the result before continuing.',
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
        description: 'Set to "worktree" to run a fresh git worktree of the repository, so its file edits cannot touch the user\'s working copy. Requires a clean git working tree; the worktree path is reported in the result.',
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
        description: 'Thinking budget for the child\'s model invocation. "off" disables extended thinking; higher levels spend more tokens on reasoning. Omit to inherit the runtime default.',
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

  execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    return this.dispatch.execute(input, workingDirectory, context);
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      try {
        const parsed = JSON.parse(result.result) as { error?: unknown };
        return {
          type: 'error',
          content: typeof parsed.error === 'string' ? parsed.error : result.result,
          metadata: result.metadata,
        };
      } catch {
        return { type: 'error', content: result.result, metadata: result.metadata };
      }
    }

    try {
      const parsed = JSON.parse(result.result) as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        return { type: 'error', content: parsed.error, metadata: result.metadata };
      }
      if (parsed.status === 'running' || parsed.background === true) {
        return {
          type: 'markdown',
          content: typeof parsed.content === 'string' ? parsed.content : 'Background subagent started.',
          metadata: {
            ...result.metadata,
            agentType: parsed.resolvedAgentType || parsed.agentType || 'task',
            sessionId: parsed.sessionId || '',
          },
        };
      }

      const agentType = parsed.resolvedAgentType || parsed.agentType || 'task';
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      const checkoutRemoved = parsed.checkoutCleanup !== null && typeof parsed.checkoutCleanup === 'object'
        && 'removed' in parsed.checkoutCleanup && parsed.checkoutCleanup.removed === true;
      const metaParts = [
        `id=${sessionId}`,
        `type=${agentType}`,
        `tools=${parsed.totalToolUseCount ?? 0}`,
        `duration_ms=${parsed.totalDurationMs ?? 0}`,
      ];
      if (parsed.totalTokens) metaParts.push(`tokens=${parsed.totalTokens}`);
      if (parsed.workingDirectory) metaParts.push(`cwd=${parsed.workingDirectory}`);
      const footerLines = [
        '<subagent_result>',
        `subagent_id: ${sessionId}`,
        `subagent_type: ${agentType}`,
        ...(checkoutRemoved ? ['The unchanged isolated checkout was removed. Start a new isolated task for further file operations.']
          : [`To continue this subagent's conversation (its history is preserved), use resume_from="${sessionId}"`]),
      ];
      if (parsed.isolation === 'worktree' && !checkoutRemoved) {
        footerLines.push(
          `This run was isolated: its file changes are in the git worktree at ${parsed.workingDirectory || '(unknown path)'}. The checkout uses detached HEAD. Adopt its committed changes by commit SHA or checkpoint ref (cherry-pick), or inspect and apply its patch. Uncommitted changes remain in that worktree.`,
        );
      }
      for (const warning of warnings) footerLines.push(`Warning: ${String(warning)}`);
      footerLines.push('</subagent_result>');
      const output = `${content}\n\n<subagent_meta>${metaParts.join(', ')}</subagent_meta>\n\n${footerLines.join('\n')}`;
      return {
        type: 'markdown',
        content: output,
        metadata: { ...result.metadata, agentType, sessionId, lineCount: content.split('\n').length },
      };
    } catch {
      return { type: 'text', content: result.result, metadata: result.metadata };
    }
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const agentType = typeof obj.subagent_type === 'string' ? obj.subagent_type : 'task';
      if (obj.name) return `${agentType}: ${String(obj.name)}`;
      const prompt = typeof obj.prompt === 'string' ? obj.prompt : undefined;
      if (prompt) return `${agentType}: ${prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt}`;
    }
    return 'task';
  }
}
