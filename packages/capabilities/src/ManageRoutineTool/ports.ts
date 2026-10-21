export interface RoutineScheduleInput {
  kind: 'every' | 'once' | 'cron';
  every?: string;
  at?: string;
  expr?: string;
  tz?: string | null;
  endAt?: string | null;
}

export type RoutineMarkerAction = 'created' | 'updated' | 'deleted' | 'paused' | 'resumed';

export interface RoutineCreateInput {
  name: string;
  prompt: string;
  schedule?: RoutineScheduleInput;
  eventTriggers?: Array<Record<string, unknown>>;
  agent: string;
  enabled: true;
}

export interface RoutineUpdateInput {
  name?: string;
  prompt?: string;
  schedule?: RoutineScheduleInput;
  eventTriggers?: Array<Record<string, unknown>>;
  enabled?: boolean;
}

export interface RoutineRecord {
  id: string;
  name: string;
  agent?: string;
  enabled?: boolean;
  schedule?: RoutineScheduleInput | null;
  eventTriggers?: Array<Record<string, unknown>>;
  lastRunAt?: number | null;
  lastError?: string | null;
}

/** Host owns session fallback, persistence, and transcript marker writes. */
export interface ManageRoutinePort {
  resolveSessionId(context: unknown): string;
  listRoutines(): Promise<readonly RoutineRecord[]>;
  createRoutine(input: RoutineCreateInput): Promise<RoutineRecord>;
  updateRoutine(id: string, input: RoutineUpdateInput): Promise<RoutineRecord>;
  deleteRoutine(id: string): Promise<void>;
  appendRoutineMarker(
    sessionId: string,
    action: RoutineMarkerAction,
    routineId: string,
    name: string,
  ): Promise<void>;
}
