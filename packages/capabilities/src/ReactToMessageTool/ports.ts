export interface ReactToMessageTranscriptRow {
  id: string;
  role?: string;
  msg_type?: string;
  source?: string | null;
  metadata?: {
    source?: string;
    reaction?: {
      targetId?: string;
      emoji?: string;
      by?: string;
      set?: unknown;
    };
  } | null;
  send_message_meta?: string | null;
}

export interface ReactToMessageInvocationContext {
  sessionId?: string;
  actorId?: string | null;
}

export interface AppendReactionInput {
  sessionId: string;
  targetId: string;
  emoji: string;
  by: string;
  set: string[];
}

/** Host-facing effects and legacy invocation context are supplied by the adapter. */
export interface ReactToMessagePort {
  resolveInvocationContext(context: unknown): ReactToMessageInvocationContext;
  getTranscript(sessionId: string): Promise<readonly ReactToMessageTranscriptRow[]>;
  appendReaction(input: AppendReactionInput): Promise<void>;
}
