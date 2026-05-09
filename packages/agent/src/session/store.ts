/**
 * store.ts - Session store implementation wrapping db.ts
 * Provides a compatible interface with the in-memory SessionManager
 */

import * as db from './db.js';
import type { Message, SessionInfo } from '../types.js';

// ============================================================
// Types
// ============================================================

/**
 * Session store interface - compatible with existing SessionStore
 */
export interface SessionStore {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: Message[];
  metadata?: Record<string, unknown>;
}

/**
 * Session store options
 */
export interface SessionStoreOptions {
  sessionId?: string;
}

// ============================================================
// Session Store Implementation
// ============================================================

/**
 * SessionStoreManager - SQLite-backed session storage
 * Wraps db.ts functions to provide a compatible interface
 */
export class SessionStoreManager {
  private currentSessionId: string | null = null;
  private currentSession: SessionStore | null = null;

  /**
   * Create a new session.
   * @param metadata - Optional session metadata
   * @returns Session info
   */
  create(metadata?: Record<string, unknown>): SessionInfo {
    const id = crypto.randomUUID();
    db.createSession({
      id,
      title: metadata?.title as string | undefined,
      model: metadata?.model as string | undefined,
      system_prompt: metadata?.system_prompt as string | undefined,
      working_directory: metadata?.working_directory as string | undefined,
      project_name: metadata?.project_name as string | undefined,
      status: metadata?.status as string | undefined,
      mode: metadata?.mode as string | undefined,
      provider_id: metadata?.provider_id as string | undefined,
    });

    const session = db.getSession(id)!;
    return db.sessionToSessionInfo(session);
  }

  /**
   * Load a session by ID.
   * @param sessionId - The session ID
   * @returns SessionStore or null if not found
   */
  load(sessionId: string): SessionStore | null {
    const session = db.getSession(sessionId);
    if (!session) {
      return null;
    }

    const messages = db.getMessages(sessionId);
    this.currentSessionId = sessionId;
    this.currentSession = {
      id: session.id,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      messageCount: messages.length,
      messages: messages.map(db.messageRowToMessage),
      metadata: {
        title: session.title,
        model: session.model,
        system_prompt: session.system_prompt,
        working_directory: session.working_directory,
        project_name: session.project_name,
        status: session.status,
        mode: session.mode,
        provider_id: session.provider_id,
      },
    };

    return this.currentSession;
  }

  /**
   * Get the current loaded session.
   * @returns Current session or null
   */
  getCurrent(): SessionStore | null {
    return this.currentSession;
  }

  /**
   * Get session info without full message load.
   * @param sessionId - The session ID
   * @returns Session info or null
   */
  getSessionInfo(sessionId: string): SessionInfo | null {
    const session = db.getSession(sessionId);
    if (!session) {
      return null;
    }
    return db.sessionToSessionInfo(session);
  }

  /**
   * Add a message to the current session.
   * @param message - The message to add
   * @returns The added message
   */
  addMessage(message: Message): Message {
    if (!this.currentSessionId) {
      throw new Error('No active session. Load a session first.');
    }

    const id = message.id || crypto.randomUUID();
    const now = Date.now();

    db.addMessage({
      id,
      session_id: this.currentSessionId,
      role: message.role,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    });

    // Reload session to get updated message count
    const messages = db.getMessages(this.currentSessionId);
    this.currentSession = {
      ...this.currentSession!,
      messageCount: messages.length,
      messages: messages.map(db.messageRowToMessage),
      updatedAt: now,
    };

    return {
      ...message,
      id,
      timestamp: now,
    };
  }

  /**
   * Get messages from the current session.
   * @returns Array of messages
   */
  getMessages(): Message[] {
    if (!this.currentSessionId) {
      return [];
    }
    return db.getMessages(this.currentSessionId).map(db.messageRowToMessage);
  }

  /**
   * Clear messages from the current session.
   */
  clearMessages(): void {
    if (!this.currentSessionId) {
      throw new Error('No active session.');
    }

    db.clearMessages(this.currentSessionId);

    this.currentSession = {
      ...this.currentSession!,
      messageCount: 0,
      messages: [],
      updatedAt: Date.now(),
    };
  }

  /**
   * Update the current session.
   * @param updates - Fields to update
   * @returns Updated session or null
   */
  updateSession(updates: {
    title?: string;
    model?: string;
    system_prompt?: string;
    working_directory?: string;
    permission_profile?: string;
    mode?: string;
    runtime_status?: string;
    runtime_error?: string | null;
  }): SessionStore | null {
    if (!this.currentSessionId) {
      throw new Error('No active session.');
    }

    const session = db.updateSession(this.currentSessionId, updates);
    if (!session) {
      return null;
    }

    const messages = db.getMessages(this.currentSessionId);
    this.currentSession = {
      id: session.id,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      messageCount: messages.length,
      messages: messages.map(db.messageRowToMessage),
      metadata: {
        title: session.title,
        model: session.model,
        system_prompt: session.system_prompt,
        working_directory: session.working_directory,
        project_name: session.project_name,
        status: session.status,
        mode: session.mode,
        provider_id: session.provider_id,
      },
    };

    return this.currentSession;
  }

  /**
   * Delete a session.
   * @param sessionId - The session ID
   * @returns True if deleted
   */
  delete(sessionId: string): boolean {
    if (this.currentSessionId === sessionId) {
      this.currentSession = null;
      this.currentSessionId = null;
    }
    return db.deleteSession(sessionId);
  }

  /**
   * List all sessions.
   * @returns Array of session info
   */
  list(): SessionInfo[] {
    return db.listSessions().map(db.sessionToSessionInfo);
  }

  /**
   * Close the current session.
   */
  close(): void {
    this.currentSession = null;
    this.currentSessionId = null;
  }
}

// ============================================================
// Export singleton instance for backward compatibility
// ============================================================

export const sessionStore = new SessionStoreManager();
