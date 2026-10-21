export interface TerminalHistoryQuery {
  readonly prefix: string;
  readonly shell?: string;
  readonly cwd?: string;
  readonly limit?: number;
}

export interface TerminalHistoryRecordInput {
  readonly command: string;
  readonly shell: string;
  readonly cwd: string;
  readonly source?: string;
}

export interface TerminalHistorySuggestion {
  readonly command: string;
  readonly suffix: string;
  readonly useCount: number;
  readonly lastUsedAt: number;
}

/** Local-only because command history can contain user-entered secrets. */
export interface HostLocalTerminalHistoryApiV1 {
  suggestTerminalHistory(query: TerminalHistoryQuery): Promise<readonly TerminalHistorySuggestion[]>;
  recordTerminalCommand(input: TerminalHistoryRecordInput): Promise<void>;
}
