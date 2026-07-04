import { randomUUID } from 'crypto';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import { MESSAGE_SESSION_TOOL_NAME } from './constants.js';
import {
  registerPendingInteragentCall,
  unregisterPendingInteragentCall,
} from '../../process/agent-process-entry.js';
import type { PendingInteragentCall } from '../../process/agent-process-entry.js';
import type { WorkerEvent } from '../../process/worker-protocol.js';

export class MessageSessionTool implements Tool {
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

  toTool(): Tool {
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
    // ToolUseContext has sessionId under options.sessionId (see types.ts).
    // process.env.SESSION_ID is always set by WorkerManager.spawnWorker.
    const callerSessionId = context?.options?.sessionId || process.env.SESSION_ID || 'unknown';
    // No agentName on ToolUseContext; fall back to a stable default.
    const callerAgentName = 'agent';

    // Create promises that resolve on chat:done / chat:error
    let resolveDone!: (event: WorkerEvent) => void;
    let resolveError!: (event: WorkerEvent) => void;
    const donePromise = new Promise<WorkerEvent>((resolve) => { resolveDone = resolve; });
    const errorPromise = new Promise<WorkerEvent>((resolve) => { resolveError = resolve; });

    // Local safety-net timer (server timer is authoritative; this is a
    // backup in case the server's chat:error event is lost).
    // The Promise executor runs synchronously, so localTimer is assigned
    // before we reference it below.
    let localTimer: ReturnType<typeof setTimeout> | undefined;
    const timerPromise = new Promise<WorkerEvent>((resolve) => {
      localTimer = setTimeout(() => {
        resolve({
          type: 'chat:error',
          sessionId: targetSessionId,
          message: 'interagent local timeout',
          code: 'timeout',
        } as WorkerEvent);
      }, (timeout + 5) * 1000); // 5s grace beyond server timer
    });

    const call: PendingInteragentCall = {
      events: [] as WorkerEvent[],
      resolveDone,
      resolveError,
      timer: localTimer!,
    };

    registerPendingInteragentCall(invokeId, call);

    // Send interagent:invoke to server via process.send
    if (process.send) {
      process.send({
        type: 'interagent:invoke',
        id: invokeId,
        callerSessionId,
        callerAgentName,
        targetSessionId,
        message,
        mode,
        timeout,
      });
    } else {
      unregisterPendingInteragentCall(invokeId);
      clearTimeout(call.timer);
      return {
        id: randomUUID(),
        name: MESSAGE_SESSION_TOOL_NAME,
        result: 'Error: process.send not available — not running as child_process',
        error: true,
      };
    }

    try {
      const terminalEvent = await Promise.race([donePromise, errorPromise, timerPromise]);

      if (terminalEvent.type === 'chat:done') {
        // Assemble final text from accumulated chat:text events
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const evt of call.events) {
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
      } else {
        // chat:error
        const errorEvent = terminalEvent as { message: string; code?: string };
        return {
          id: randomUUID(),
          name: MESSAGE_SESSION_TOOL_NAME,
          result: `Error from target session: ${errorEvent.message}${errorEvent.code ? ` (code: ${errorEvent.code})` : ''}`,
          error: true,
        };
      }
    } finally {
      clearTimeout(call.timer);
      unregisterPendingInteragentCall(invokeId);
    }
  }
}

export const messageSessionTool = new MessageSessionTool();
