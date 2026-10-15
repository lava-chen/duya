import type { Message } from '@duya/agent-core/message';
import { messageDb, sessionDb } from '../worker-db-client.js';
import { logger } from '../worker-logger.js';

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
  sessionId: string;
  agentName?: string;
  workingDirectory?: string;
  history: Message[];
}

export interface ResolveResumeTargetInput {
  resumeFrom: string;
  parentSessionId?: string;
  messageRowToMessage(row: unknown): Message;
}

interface SubagentSessionRow {
  id?: string;
  agent_type?: string | null;
  agent_name?: string | null;
  parent_session_id?: string | null;
  working_directory?: string | null;
}

/** Resolve and replay a child session while enforcing parent ownership. */
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
    logger.warn('[SubAgent] resume_from session lookup failed', { resumeFrom, err }, 'SubAgent');
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
      message: `resume_from "${resumeFrom}" is not a known session id. Use the subagent_id returned by a previous task call, or omit resume_from to start a new sub-agent.`,
    };
  }
  if (row.agent_type !== SUB_AGENT_SESSION_TYPE) {
    return {
      ok: false,
      code: 'not_a_subagent',
      message: `resume_from "${resumeFrom}" is a top-level session, not a sub-agent session. Only sub-agent ids can be resumed.`,
    };
  }
  if (input.parentSessionId && row.parent_session_id && row.parent_session_id !== input.parentSessionId) {
    return {
      ok: false,
      code: 'foreign_session',
      message: `resume_from "${resumeFrom}" belongs to a different parent session and cannot be resumed from here.`,
    };
  }

  let history: Message[];
  try {
    const loaded = (await messageDb.loadMessages(resumeFrom)) as { messages?: unknown[] } | undefined;
    history = Array.isArray(loaded?.messages)
      ? loaded.messages.map(input.messageRowToMessage)
      : [];
  } catch (err) {
    logger.warn('[SubAgent] resume_from history load failed', { resumeFrom, err }, 'SubAgent');
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
  }, 'SubAgent');
  return {
    ok: true,
    sessionId: resumeFrom,
    ...(row.agent_name ? { agentName: row.agent_name } : {}),
    ...(row.working_directory ? { workingDirectory: row.working_directory } : {}),
    history,
  };
}
