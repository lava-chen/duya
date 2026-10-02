/**
 * resumeAgent.ts — `resume_from` implementation for the `task` tool.
 *
 * `resume_from` lets the model continue a sub-agent's own conversation
 * instead of briefing a fresh one from scratch. The continuation reuses the
 * **same** sub-agent session id, so the child's transcript is one continuous
 * thread in the DB and the renderer side pane keeps following the same row —
 * that is the whole point of resuming rather than re-spawning.
 *
 * A sub-agent has no worker of its own (it runs in-process inside the parent
 * worker), so "resuming" is: load the persisted messages of the target
 * session, hand them to `runAgent` as the leading context, and append the new
 * user prompt. `runAgent` already flattens `promptMessages` into a single
 * `[ROLE]: text` transcript, so no new conversation machinery is needed.
 */

import { sessionDb, messageDb } from '../../ipc/db-client.js';
import { messageRowToMessage, type MessageRow } from '../../session/db.js';
import { logger } from '../../utils/logger.js';
import type { Message } from '../../types.js';

/** `chat_sessions.agent_type` value stamped on every sub-agent session. */
const SUB_AGENT_SESSION_TYPE = 'sub-agent';

export type ResumeErrorCode =
  | 'unknown_session'
  | 'not_a_subagent'
  | 'foreign_session'
  | 'no_history'
  | 'load_failed';

export interface ResumeTargetError {
  ok: false;
  code: ResumeErrorCode;
  message: string;
}

export interface ResumeTarget {
  ok: true;
  /** Session id to re-run the child under. */
  sessionId: string;
  /** `agent_name` recorded on the session row, when present. */
  agentName?: string;
  /** Working directory the original run used. */
  workingDirectory?: string;
  /** Prior transcript, oldest → newest. */
  history: Message[];
}

export interface ResolveResumeTargetInput {
  /** Raw `resume_from` value from the model. */
  resumeFrom: string;
  /** Parent session issuing the resume — guards cross-session resumption. */
  parentSessionId?: string;
}

/** Minimal shape of the `chat_sessions` row we depend on. */
interface SubagentSessionRow {
  id?: string;
  agent_type?: string | null;
  agent_name?: string | null;
  parent_session_id?: string | null;
  working_directory?: string | null;
}

/**
 * Load the sub-agent session a `resume_from` value points at.
 *
 * Design choice (required by plan 571): an unknown / non-sub-agent id is a
 * **hard structured error**, not a silent fresh start. Silently starting
 * over would hand the model a "resumed" transcript that is actually empty —
 * the model would then report conclusions from work that never happened,
 * which is strictly worse than a refusal it can correct by passing a real id.
 */
export async function resolveResumeTarget(
  input: ResolveResumeTargetInput,
): Promise<ResumeTarget | ResumeTargetError> {
  const resumeFrom = input.resumeFrom.trim();
  if (!resumeFrom) {
    return {
      ok: false,
      code: 'unknown_session',
      message: 'resume_from must be a non-empty subagent_id / session id.',
    };
  }

  let row: SubagentSessionRow | null;
  try {
    row = (await sessionDb.get(resumeFrom)) as SubagentSessionRow | null;
  } catch (err) {
    logger.warn('[SubAgent] resume_from session lookup failed', { resumeFrom, err }, 'SubAgent')
    return {
      ok: false,
      code: 'load_failed',
      message: `Could not read session ${resumeFrom}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!row || !row.id) {
    return {
      ok: false,
      code: 'unknown_session',
      message: `resume_from "${resumeFrom}" is not a known session id. Use the subagent_id returned by a previous ${'task'} call, or omit resume_from to start a new sub-agent.`,
    };
  }

  if (row.agent_type !== SUB_AGENT_SESSION_TYPE) {
    return {
      ok: false,
      code: 'not_a_subagent',
      message: `resume_from "${resumeFrom}" is a top-level session, not a sub-agent session. Only sub-agent ids can be resumed.`,
    };
  }

  // A parent may only resume its own children. Without this the model could
  // hijack an unrelated session's transcript into its own context.
  if (input.parentSessionId && row.parent_session_id && row.parent_session_id !== input.parentSessionId) {
    return {
      ok: false,
      code: 'foreign_session',
      message: `resume_from "${resumeFrom}" belongs to a different parent session and cannot be resumed from here.`,
    };
  }

  let history: Message[] = [];
  try {
    const loaded = (await messageDb.loadMessages(resumeFrom)) as
      | { messages?: MessageRow[] }
      | undefined;
    const rows = Array.isArray(loaded?.messages) ? loaded.messages : [];
    // No attachment map: `getAttachmentsForSession` opens SQLite directly,
    // which is not valid in the agent worker (it uses the IPC db client).
    // Attachment rehydration only affects image blocks, and a text
    // continuation does not need them.
    history = rows.map((r) => messageRowToMessage(r));
  } catch (err) {
    logger.warn('[SubAgent] resume_from history load failed', { resumeFrom, err }, 'SubAgent')
    return {
      ok: false,
      code: 'load_failed',
      message: `Could not load the transcript of session ${resumeFrom}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (history.length === 0) {
    return {
      ok: false,
      code: 'no_history',
      message: `resume_from "${resumeFrom}" has no prior messages to continue. Omit resume_from to start a new sub-agent.`,
    };
  }

  logger.info('[SubAgent] resume target resolved', {
    resumeFrom,
    parentSessionId: input.parentSessionId,
    agentName: row.agent_name ?? undefined,
    historyMessages: history.length,
  }, 'SubAgent')

  return {
    ok: true,
    sessionId: resumeFrom,
    ...(row.agent_name ? { agentName: row.agent_name } : {}),
    ...(row.working_directory ? { workingDirectory: row.working_directory } : {}),
    history,
  };
}
