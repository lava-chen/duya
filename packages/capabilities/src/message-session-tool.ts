import { randomUUID } from 'node:crypto';
import { BaseTool } from './BaseTool.js';
import type { ToolResult, ToolUseContext } from './contracts/tool.js';
import type { WorkerEvent } from '@duya/agent-protocol/worker-protocol';

export const MESSAGE_SESSION_TOOL_NAME = 'MessageSession';

export interface InteragentInvokeRequest {
  id: string;
  callerSessionId: string;
  callerAgentName: string;
  targetSessionId: string;
  message: string;
  mode: 'minimal' | 'full';
  timeout: number;
}

export type MessageSessionInvocationResult =
  | { kind: 'unavailable' }
  | { kind: 'terminal'; terminalEvent: WorkerEvent; events: readonly WorkerEvent[] };

/** Host owns process IPC, pending-call correlation, and the safety timer. */
export interface MessageSessionPort {
  getCallerSessionId(contextSessionId?: string): string;
  invoke(request: InteragentInvokeRequest): Promise<MessageSessionInvocationResult>;
}

export class MessageSessionTool extends BaseTool {
  readonly name = MESSAGE_SESSION_TOOL_NAME;
  readonly description = `Send a message to another session's agent and receive its response. The target agent is revived with its full conversation context and can answer questions about what it did, what it found, or perform lookups.

## When to use
- After SessionSearch finds a relevant past session, ask that session's agent directly what it did or discovered.
- When you need information from another session's working context that a text search cannot capture.
- When the target session's agent can use its tools (Read, Grep, Glob in minimal mode) to answer your question.

## Modes
- **minimal** (default): target agent gets read-only tools (Read, Grep, Glob). Fast, no permission prompts. Use for "what did you do?" questions.
- **full**: target agent gets its full toolset. Permission prompts surface to the user. Use when the target needs to write or execute.

## Output
Returns the target agent's final text response. If the target agent used tools, a brief summary of tool calls is included.`;

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      targetSessionId: {
        type: 'string',
        description: 'ID of the session whose agent to message. Use SessionSearch first to find the right session.',
      },
      message: {
        type: 'string',
        description: 'Message/question for the target agent. Plain content; your identity is conveyed via metadata automatically.',
      },
      mode: {
        type: 'string',
        enum: ['minimal', 'full'],
        default: 'minimal',
        description: 'minimal: read-only tools, no prompts. full: normal toolset, prompts surface to user.',
      },
      timeout: {
        type: 'number',
        default: 60,
        description: 'Hard timeout in seconds. On expiry the target agent is interrupted.',
      },
    },
    required: ['targetSessionId', 'message'],
  };

  constructor(private readonly port: MessageSessionPort) {
    super();
  }

  toTool(): { name: string; description: string; input_schema: Record<string, unknown> } {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const targetSessionId = input.targetSessionId as string;
    const message = input.message as string;
    const mode = (input.mode as 'minimal' | 'full') || 'minimal';
    const timeout = (input.timeout as number) || 60;

    const invokeId = randomUUID();
    const callerSessionId = this.port.getCallerSessionId(context?.options?.sessionId);
    // No agentName on ToolUseContext; fall back to a stable default.
    const callerAgentName = 'agent';
    const invocation = await this.port.invoke({
      id: invokeId,
      callerSessionId,
      callerAgentName,
      targetSessionId,
      message,
      mode,
      timeout,
    });

    if (invocation.kind === 'unavailable') {
      return {
        id: randomUUID(),
        name: MESSAGE_SESSION_TOOL_NAME,
        result: 'Error: process.send not available — not running as child_process',
        error: true,
      };
    }

    const { terminalEvent, events } = invocation;
    if (terminalEvent.type === 'chat:done') {
      // Assemble final text from accumulated chat:text events
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const evt of events) {
        if (evt.type === 'chat:text') {
          textParts.push(evt.content);
        } else if (evt.type === 'chat:tool_use') {
          toolCalls.push(evt.name);
        }
      }
      const text = textParts.join('');
      const toolSummary = toolCalls.length > 0
        ? `\n\n[Target agent used tools: ${toolCalls.join(', ')}]`
        : '';
      return {
        id: randomUUID(),
        name: MESSAGE_SESSION_TOOL_NAME,
        result: text + toolSummary,
      };
    }

    // chat:error
    const errorEvent = terminalEvent as { message?: string; code?: string };
    return {
      id: randomUUID(),
      name: MESSAGE_SESSION_TOOL_NAME,
      result: `Error from target session: ${errorEvent.message ?? 'Unknown error'}${errorEvent.code ? ` (code: ${errorEvent.code})` : ''}`,
      error: true,
    };
  }
}
