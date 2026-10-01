export enum SessionState {
  IDLE = 'IDLE',
  STREAMING = 'STREAMING',
  COMPLETING = 'COMPLETING',
  CRASHED = 'CRASHED',
  ERROR = 'ERROR',
  COMPLETED = 'COMPLETED',
}

export interface Session {
  id: string;
  state: SessionState;
  createdAt: number;
  workerPid?: number;
  lastCheckpoint?: unknown;
  lastCheckpointTime?: number;
  turnCount: number;
  lastEventId: number;
  exitCode?: number;
  exitSignal?: string;
  errorMessage?: string;
  errorRetryable?: boolean;
  lastDoneData?: unknown;
  lastMessages?: unknown;
}

export interface AgentEvent {
  event: string;
  data: unknown;
}

export interface SessionEventRecord {
  eventId: number;
  eventType: string;
  data: unknown;
  timestamp: number;
}

export const SESSION_EVENT_BUFFER_SIZE = 500;

const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  [SessionState.IDLE]: [SessionState.STREAMING, SessionState.COMPLETING],
  [SessionState.STREAMING]: [SessionState.COMPLETING, SessionState.COMPLETED, SessionState.CRASHED, SessionState.ERROR, SessionState.IDLE],
  [SessionState.COMPLETING]: [SessionState.COMPLETED, SessionState.CRASHED, SessionState.ERROR, SessionState.IDLE],
  [SessionState.CRASHED]: [SessionState.IDLE],
  [SessionState.ERROR]: [SessionState.IDLE],
  [SessionState.COMPLETED]: [SessionState.STREAMING, SessionState.COMPLETING],
};

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}
