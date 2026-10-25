/**
 * End-of-turn suggestion: the one follow-up prompt the worker predicts the
 * user would type next.
 *
 * Transport-neutral and IO-free. The worker writes the row after a turn
 * finishes; any surface reads it back through the Host, so the suggestion is
 * not tied to whichever client happened to be attached.
 */

/** What the worker writes once a turn produced a suggestion. */
export interface TurnSuggestionWriteInput {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** The predicted next user prompt. Already trimmed and validated by the writer. */
  readonly suggestion: string;
  readonly createdAt: number;
}

/** The persisted projection a surface reads back. */
export interface HostLocalTurnSuggestionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly suggestion: string;
  readonly createdAt: number;
}

export interface HostLocalTurnSuggestionApiV1 {
  saveTurnSuggestion(input: TurnSuggestionWriteInput): Promise<void>;
  getLatestTurnSuggestion(sessionId: string): Promise<HostLocalTurnSuggestionRecord | null>;
}
