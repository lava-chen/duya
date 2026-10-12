/** Durable, JSON-serializable workflow journal record shared by Runtime and Host. */
export interface JournalRecord {
  seq: number;
  kind: 'node_result' | 'decision' | 'approval' | 'artifact' | 'phase';
  nodeId: string;
  attempt: number;
  reqHash?: string;
  result?: unknown;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';
  verification?: 'verified' | 'unconfirmed';
  errorClass?: string;
  atMs: number;
  nodeKind?: 'tool' | 'agent' | 'decision' | 'human' | 'gui' | 'browser' | 'ask' | 'noop';
  action?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputSize?: number;
  childSessionId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  inputSummary?: string;
  replayed?: boolean;
}
