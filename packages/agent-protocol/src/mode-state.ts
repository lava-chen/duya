/** Durable snapshot row for a session-scoped mode tracker. */
export interface ModeStateRow {
  sessionId: string;
  mode: string;
  status: string;
  reminderCount: number;
  snapshotJson: string;
  updatedAt: number;
}

export interface ModeStateUpsertInput {
  sessionId: string;
  mode: string;
  status: string;
  snapshotJson: string;
  reminderCount?: number;
}

/** Typed async boundary for persisted mode tracker snapshots. */
export interface HostModeStateApiV1 {
  getModeState(sessionId: string, mode: string): Promise<ModeStateRow | null>;
  upsertModeState(input: ModeStateUpsertInput): Promise<void>;
  setModeStateStatus(sessionId: string, mode: string, status: string): Promise<void>;
  listModeStateBySession(sessionId: string): Promise<ModeStateRow[]>;
}
