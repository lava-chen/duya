/**
 * session-manager.ts - Session ↔ MessagePort mapping and lifecycle management
 *
 * Manages the mapping between chat sessions and their communication channels.
 * Each session can have an associated agent instance and MessagePort for
 * direct communication with the daemon worker.
 *
 * Responsibilities:
 * 1. Track active sessions and their states
 * 2. Map sessions to their MessagePort channels
 * 3. Clean up resources when sessions are closed
 * 4. Provide session state queries for the main process
 */

import { BrowserWindow } from 'electron';

export type SessionState = 'active' | 'idle' | 'streaming' | 'error' | 'closed';

export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;
  model: string;
  workingDirectory: string;
}

class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  registerSession(sessionId: string, options: { model?: string; workingDirectory?: string } = {}): SessionInfo {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const info: SessionInfo = {
      sessionId,
      state: 'idle',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      model: options.model || '',
      workingDirectory: options.workingDirectory || '',
    };

    this.sessions.set(sessionId, info);
    console.log(`[SessionManager] Session registered: ${sessionId}`);
    return info;
  }

  unregisterSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      console.log(`[SessionManager] Session unregistered: ${sessionId}`);
    }
    return deleted;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  updateSessionState(sessionId: string, state: SessionState): boolean {
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    info.state = state;
    info.lastActivityAt = Date.now();
    return true;
  }

  updateSessionActivity(sessionId: string): boolean {
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    info.lastActivityAt = Date.now();
    return true;
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).filter(s => s.state !== 'closed');
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getStreamingSessionCount(): number {
    let count = 0;
    for (const info of this.sessions.values()) {
      if (info.state === 'streaming') count++;
    }
    return count;
  }

  broadcastSessionEvent(event: string, data: Record<string, unknown>): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(event, data);
      }
    }
  }

  cleanupStaleSessions(maxIdleMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, info] of this.sessions.entries()) {
      if (info.state === 'closed' || (info.state === 'idle' && now - info.lastActivityAt > maxIdleMs)) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[SessionManager] Cleaned up ${cleaned} stale sessions`);
    }
    return cleaned;
  }

  shutdown(): void {
    for (const info of this.sessions.values()) {
      info.state = 'closed';
    }
    this.sessions.clear();
    console.log('[SessionManager] All sessions cleared');
  }
}

let sessionManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}

export function initSessionManager(): SessionManager {
  if (sessionManager) {
    console.warn('[SessionManager] Already initialized');
    return sessionManager;
  }
  sessionManager = new SessionManager();

  setInterval(() => {
    sessionManager?.cleanupStaleSessions();
  }, 60 * 60 * 1000);

  return sessionManager;
}
