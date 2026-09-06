/**
 * Session Tool Implementation (Plan 504 — grok CloudAgent parity, minimal loop).
 *
 * Spawns a real, project-scoped child session in a given working directory and
 * runs it asynchronously. The MAIN process creates the child session row and
 * fires an ordinary agent run (POST /sessions/:id/chat); when it finishes the
 * parent is woken via a `background_notification` mailbox row. This tool
 * returns immediately with the child session id — the caller carries on and is
 * auto-woken with the result (it must NOT poll).
 *
 * Unlike MessageSession (a blocking one-shot Q&A to an EXISTING session) and
 * SendToAgent (an async message to another agent), this tool CREATES and
 * manages a NEW session that persists in the sidebar with its own transcript.
 */

import { randomUUID } from 'node:crypto';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import { SESSION_TOOL_NAME } from './constants.js';
import { sessionSpawnDb } from '../../ipc/db-client.js';

/** Input schema for the session tool (spawn + continuous management). */
const SESSION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['spawn', 'list', 'get', 'reply', 'cancel', 'rename'],
      default: 'spawn',
      description:
        'The operation to perform. spawn: create a new child session in a project and run it async. list: list child sessions you spawned. get: status + diff stats of a child. reply: send a follow-up prompt to a child (another async run). cancel: interrupt a child run. rename: rename a child.',
    },
    workingDirectory: {
      type: 'string',
      description:
        'For spawn: the project directory the child session operates in (absolute path). The child runs with this as its workspace, so it can Read/Edit/build files there independently.',
    },
    prompt: {
      type: 'string',
      description:
        'For spawn/reply: the task or follow-up instruction for the child session.',
    },
    model: {
      type: 'string',
      description:
        'For spawn/reply: optional model override. Omit to use the active provider\x27s default model.',
    },
    sessionId: {
      type: 'string',
      description:
        'For get/reply/cancel/rename: the child session id returned by spawn. You can only manage sessions you spawned.',
    },
    title: {
      type: 'string',
      description: 'For rename: the new title for the child session.',
    },
  },
  required: [],
};

export class SessionTool implements Tool {
  readonly name = SESSION_TOOL_NAME;
  readonly description = `Create and manage independent child sessions in specified projects (grok CloudAgent parity).

## When to use
- When a task is long-running, self-contained in one project, and you want it to
  run in its OWN session with its own transcript and working directory
  (e.g. a deep refactor, a large build, an isolated experiment).
- When you want a normal project session and a bot/agent session to be connected:
  spawn real project sessions to do work, then get woken with their results.

## Behavior
- ASYNC + auto-wake: spawn/reply return immediately; the child runs in its own
  session and you are auto-woken with its result when it finishes. Do NOT poll.
- Management is scoped to sessions you spawned (the parent). Use list/get/reply/
  cancel/rename to continuously manage them across turns.

## Actions
- spawn: workingDirectory (required) + prompt (required) + model (optional).
- list: list child sessions you spawned.
- get: sessionId → status, working directory, and diff stats (+N/-M files).
- reply: sessionId + prompt → send a follow-up prompt to the child (async run;
  you are woken again on completion).
- cancel: sessionId → interrupt the child's active run.
- rename: sessionId + title → rename the child.

## Restrictions
- You can only manage sessions you spawned (ownership enforced server-side).
- Heavy spawns consume an additional worker; concurrency is bounded by system
  worker limits.`;

  readonly input_schema: Record<string, unknown> = SESSION_SCHEMA;

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
    const action = (input.action as string) || 'spawn';
    const sessionId = input.sessionId as string | undefined;
    const callerSessionId = context?.options?.sessionId || process.env.SESSION_ID || 'unknown';

    const err = (msg: string): ToolResult => ({
      id: randomUUID(),
      name: this.name,
      result: `Error: ${msg}`,
      error: true,
    });

    try {
      switch (action) {
        case 'spawn': {
          const workingDirectory = input.workingDirectory as string | undefined;
          const prompt = (input.prompt as string) || '';
          const model = input.model as string | undefined;
          if (!workingDirectory || !prompt) {
            return err('workingDirectory and prompt are required for spawn.');
          }
          const result = (await sessionSpawnDb.spawn({
            parentSessionId: callerSessionId,
            workingDirectory,
            prompt,
            ...(model ? { model } : {}),
          })) as unknown as
            | { ok: true; sessionId: string; parentId: string }
            | { ok: false; reason: string };
          if (!result.ok) return err(`Failed to spawn session: ${result.reason}`);
          return {
            id: randomUUID(),
            name: this.name,
            result:
              `Spawned session ${result.sessionId} in ${workingDirectory}. It is running asynchronously ` +
              `in its own session (visible in the sidebar). You will be auto-woken with its result when ` +
              `it finishes — do not poll.`,
          };
        }

        case 'list': {
          const result = (await sessionSpawnDb.list(callerSessionId)) as unknown as
            | { ok: true; sessions: Array<{ id: string; title: string | null; status: string | null; working_directory: string | null; updated_at?: number; created_at?: number }> }
            | { ok: false; reason: string };
          if (!result.ok) return err(`Failed to list sessions: ${result.reason}`);
          if (result.sessions.length === 0) {
            return {
              id: randomUUID(),
              name: this.name,
              result: 'No child sessions spawned from this session yet. Use action "spawn".',
            };
          }
          const lines = result.sessions.map((s) => {
            const stat = (s.status as string | null) || 'pending';
            return `- ${s.id} — ${s.title?.trim() || '(untitled)'} [${stat}] ${s.working_directory || ''}`;
          });
          return {
            id: randomUUID(),
            name: this.name,
            result: `Child sessions (${result.sessions.length}):\n${lines.join('\n')}\n\nUse action "get" with a sessionId for status + diff stats.`,
          };
        }

        case 'get': {
          if (!sessionId) return err('sessionId is required for get.');
          const result = (await sessionSpawnDb.get(sessionId, callerSessionId)) as unknown as
            | {
                ok: true;
                session: {
                  id: string;
                  title: string;
                  status: string;
                  workingDirectory: string;
                  filesChanged: number;
                  linesAdded: number;
                  linesRemoved: number;
                  updatedAt: number;
                  createdAt: number;
                };
              }
            | { ok: false; reason: string };
          if (!result.ok) return err(`Could not get session ${sessionId}: ${result.reason}`);
          const s = result.session;
          const changeBits: string[] = [`${s.status}`];
          if (s.filesChanged > 0) {
            changeBits.push(`+${s.linesAdded}/-${s.linesRemoved} across ${s.filesChanged} file(s)`);
          }
          return {
            id: randomUUID(),
            name: this.name,
            result:
              `Session ${s.id} — ${s.title || '(untitled)'}\n` +
              `Status: ${changeBits.join(', ')}\n` +
              `Working directory: ${s.workingDirectory}\n` +
              `Use action "reply" to send a follow-up, "cancel" to interrupt, or "rename" to title it.`,
          };
        }

        case 'reply': {
          const prompt = (input.prompt as string) || '';
          const model = input.model as string | undefined;
          if (!sessionId || !prompt) return err('sessionId and prompt are required for reply.');
          const result = (await sessionSpawnDb.reply({
            sessionId,
            callerSessionId,
            prompt,
            ...(model ? { model } : {}),
          })) as unknown as { ok: boolean; sessionId?: string; reason?: string };
          if (!result.ok) return err(`Could not reply to ${sessionId}: ${result.reason}`);
          return {
            id: randomUUID(),
            name: this.name,
            result:
              `Sent follow-up to ${sessionId}. It runs asynchronously — you will be auto-woken ` +
              `with the result when it finishes. Do not poll.`,
          };
        }

        case 'cancel': {
          if (!sessionId) return err('sessionId is required for cancel.');
          const result = (await sessionSpawnDb.cancel(sessionId, callerSessionId)) as unknown as
            | { ok: true; sessionId: string }
            | { ok: false; reason: string };
          if (!result.ok) return err(`Could not cancel ${sessionId}: ${result.reason}`);
          return {
            id: randomUUID(),
            name: this.name,
            result: `Requested cancellation of the active run for ${sessionId}.`,
          };
        }

        case 'rename': {
          const title = (input.title as string) || '';
          if (!sessionId || !title.trim()) return err('sessionId and title are required for rename.');
          const result = (await sessionSpawnDb.rename(sessionId, callerSessionId, title)) as unknown as
            | { ok: true; sessionId: string }
            | { ok: false; reason: string };
          if (!result.ok) return err(`Could not rename ${sessionId}: ${result.reason}`);
          return {
            id: randomUUID(),
            name: this.name,
            result: `Renamed ${sessionId} to "${title.trim()}".`,
          };
        }

        default:
          return err(`action "${action}" is not supported.`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(`Failed to run '${action}': ${message}`);
    }
  }
}

export const sessionTool = new SessionTool();