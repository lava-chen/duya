import { Session, SessionState, SessionEventRecord, SESSION_EVENT_BUFFER_SIZE, isValidTransition } from './types';
import { sessionLogger, createLogger } from './logger';

export class SessionManager {
  private sessions = new Map<string, Session>();
  private eventBuffers = new Map<string, SessionEventRecord[]>();

  createSession(id: string): Session {
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`);
    }

    const session: Session = {
      id,
      state: SessionState.IDLE,
      createdAt: Date.now(),
      turnCount: 0,
      lastEventId: 0,
    };

    this.sessions.set(id, session);
    sessionLogger.info('Session created', { sessionId: id, state: SessionState.IDLE });
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  transitionState(id: string, newState: SessionState): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    if (!isValidTransition(session.state, newState)) {
      throw new Error(
        `Invalid state transition for session ${id}: ${session.state} → ${newState}`
      );
    }

    const prevState = session.state;
    session.state = newState;
    sessionLogger.info('State transition', { sessionId: id, from: prevState, to: newState });
    return session;
  }

  setWorkerPid(id: string, pid: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.workerPid = pid;
    sessionLogger.info('Worker pid set', { sessionId: id, pid });
  }

  setLastCheckpoint(id: string, checkpoint: unknown): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.lastCheckpoint = checkpoint;
    session.lastCheckpointTime = Date.now();
    sessionLogger.info('Checkpoint saved', { sessionId: id, checkpointTime: session.lastCheckpointTime });
  }

  setExitInfo(id: string, exitCode: number, exitSignal?: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.exitCode = exitCode;
    session.exitSignal = exitSignal;
    sessionLogger.info('Worker exit info', { sessionId: id, exitCode, exitSignal });
  }

  setError(id: string, message: string, retryable?: boolean): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.errorMessage = message;
    session.errorRetryable = retryable;
    sessionLogger.error('Session error', undefined, { sessionId: id, message, retryable });
  }

  failSession(id: string, message: string, retryable?: boolean): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.setError(id, message, retryable);
    if (session.state === SessionState.STREAMING || session.state === SessionState.COMPLETING) {
      this.transitionState(id, SessionState.ERROR);
    }
  }

  setDoneData(id: string, doneData: unknown): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastDoneData = doneData;
  }

  setLastMessages(id: string, messages: unknown): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastMessages = messages;
  }

  incrementTurnCount(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.turnCount++;
  }

  updateLastEventId(id: string, eventId: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastEventId = eventId;
  }

  recordEvent(id: string, eventType: string, data: unknown, eventId: number): void {
    let buffer = this.eventBuffers.get(id);
    if (!buffer) {
      buffer = [];
      this.eventBuffers.set(id, buffer);
    }

    const record: SessionEventRecord = {
      eventId,
      eventType,
      data,
      timestamp: Date.now(),
    };

    buffer.push(record);

    if (buffer.length > SESSION_EVENT_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - SESSION_EVENT_BUFFER_SIZE);
    }
  }

  getEventsSince(id: string, sinceEventId: number): SessionEventRecord[] {
    const buffer = this.eventBuffers.get(id);
    if (!buffer) return [];
    return buffer.filter(r => r.eventId > sinceEventId);
  }

  destroySession(id: string): boolean {
    const existed = this.sessions.has(id);
    this.eventBuffers.delete(id);
    const deleted = this.sessions.delete(id);
    if (deleted) {
      sessionLogger.info('Session destroyed', { sessionId: id });
    }
    return deleted;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}
