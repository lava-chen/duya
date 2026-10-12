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
  exitSignal?: string | undefined;
  errorMessage?: string;
  errorRetryable?: boolean | undefined;
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

const VALID_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  [SessionState.IDLE]: [SessionState.STREAMING, SessionState.COMPLETING],
  [SessionState.STREAMING]: [
    SessionState.COMPLETING,
    SessionState.COMPLETED,
    SessionState.CRASHED,
    SessionState.ERROR,
    SessionState.IDLE,
  ],
  [SessionState.COMPLETING]: [
    SessionState.COMPLETED,
    SessionState.CRASHED,
    SessionState.ERROR,
    SessionState.IDLE,
  ],
  [SessionState.CRASHED]: [SessionState.IDLE],
  [SessionState.ERROR]: [SessionState.IDLE],
  [SessionState.COMPLETED]: [SessionState.STREAMING, SessionState.COMPLETING],
};

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export interface WorkerSessionRegistryLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, error?: Error, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: WorkerSessionRegistryLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Host-owned in-memory lifecycle and replay buffer for supervised workers. */
export class WorkerSessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly eventBuffers = new Map<string, SessionEventRecord[]>();

  constructor(private readonly logger: WorkerSessionRegistryLogger = NOOP_LOGGER) {}

  createSession(id: string): Session {
    if (this.sessions.has(id)) throw new Error(`Session ${id} already exists`);
    const session: Session = {
      id,
      state: SessionState.IDLE,
      createdAt: Date.now(),
      turnCount: 0,
      lastEventId: 0,
    };
    this.sessions.set(id, session);
    this.logger.info('Session created', { sessionId: id, state: SessionState.IDLE });
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  transitionState(id: string, newState: SessionState): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (session.state === newState) return session;
    if (!isValidTransition(session.state, newState)) {
      throw new Error(`Invalid state transition for session ${id}: ${session.state} → ${newState}`);
    }
    const previous = session.state;
    session.state = newState;
    this.logger.info('State transition', { sessionId: id, from: previous, to: newState });
    return session;
  }

  setWorkerPid(id: string, pid: number): void {
    const session = this.requireSession(id);
    session.workerPid = pid;
    this.logger.info('Worker pid set', { sessionId: id, pid });
  }

  setLastCheckpoint(id: string, checkpoint: unknown): void {
    const session = this.requireSession(id);
    session.lastCheckpoint = checkpoint;
    session.lastCheckpointTime = Date.now();
    this.logger.info('Checkpoint saved', { sessionId: id, checkpointTime: session.lastCheckpointTime });
  }

  setExitInfo(id: string, exitCode: number, exitSignal?: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.exitCode = exitCode;
    session.exitSignal = exitSignal;
    this.logger.info('Worker exit info', { sessionId: id, exitCode, exitSignal });
  }

  setError(id: string, message: string, retryable?: boolean): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.errorMessage = message;
    session.errorRetryable = retryable;
    this.logger.error('Session error', undefined, { sessionId: id, message, retryable });
  }

  failSession(id: string, message: string, retryable?: boolean): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.setError(id, message, retryable);
    if (session.state === SessionState.STREAMING || session.state === SessionState.COMPLETING) {
      try {
        this.transitionState(id, SessionState.ERROR);
      } catch (error) {
        this.logger.warn('Failed to transition to ERROR state', {
          sessionId: id,
          currentState: session.state,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  setDoneData(id: string, doneData: unknown): void {
    const session = this.sessions.get(id);
    if (session) session.lastDoneData = doneData;
  }

  setLastMessages(id: string, messages: unknown): void {
    const session = this.sessions.get(id);
    if (session) session.lastMessages = messages;
  }

  incrementTurnCount(id: string): void {
    this.requireSession(id).turnCount += 1;
  }

  updateLastEventId(id: string, eventId: number): void {
    const session = this.sessions.get(id);
    if (session) session.lastEventId = eventId;
  }

  recordEvent(id: string, eventType: string, data: unknown, eventId: number): void {
    let buffer = this.eventBuffers.get(id);
    if (!buffer) {
      buffer = [];
      this.eventBuffers.set(id, buffer);
    }
    buffer.push({ eventId, eventType, data, timestamp: Date.now() });
    if (buffer.length > SESSION_EVENT_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - SESSION_EVENT_BUFFER_SIZE);
    }
  }

  getEventsSince(id: string, sinceEventId: number): SessionEventRecord[] {
    return (this.eventBuffers.get(id) ?? []).filter((record) => record.eventId > sinceEventId);
  }

  destroySession(id: string): boolean {
    this.eventBuffers.delete(id);
    const deleted = this.sessions.delete(id);
    if (deleted) this.logger.info('Session destroyed', { sessionId: id });
    return deleted;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    return session;
  }
}
