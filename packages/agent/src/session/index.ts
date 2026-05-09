/**
 * Session Manager - SQLite-backed session state management and persistence
 * Handles session creation, saving, loading, and message history compression
 */

import crypto from 'node:crypto';
import type { Message, SessionInfo, MessageContent } from '../types.js';
import { SessionStoreManager, sessionStore } from './store.js';
import * as db from './db.js';

// Re-export db functions for direct access
export * from './db.js';

// Re-export store exports
export { SessionStoreManager, sessionStore } from './store.js';

// ============================================================
// Types
// ============================================================

export interface SessionStore {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: Message[];
  metadata?: Record<string, unknown>;
}

export interface SessionManagerOptions {
  storageDir?: string;
  maxMessages?: number;
  maxTokensPerMessage?: number;
}

interface TokenEstimate {
  totalTokens: number;
  canAddMore: boolean;
  needsCompression: boolean;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_STORAGE_DIR = '.duya/sessions';
const DEFAULT_MAX_MESSAGES = 1000;
const DEFAULT_MAX_TOKENS_PER_MESSAGE = 4000;

/**
 * Rough estimation: 1 token ≈ 4 characters for English
 * This is a conservative estimate
 */
const CHARS_PER_TOKEN = 4;

// ============================================================
// Session Manager (SQLite-backed)
// ============================================================

/**
 * SessionManager - SQLite-backed session management
 * Maintains compatibility with the original in-memory API
 */
export class SessionManager {
  private store: SessionStoreManager;
  private maxTokensPerMessage: number;

  constructor(options: SessionManagerOptions = {}) {
    this.store = new SessionStoreManager();
    this.maxTokensPerMessage = options.maxTokensPerMessage || DEFAULT_MAX_TOKENS_PER_MESSAGE;
  }

  /**
   * Initialize storage (no-op for SQLite, DB is initialized on first access)
   */
  async init(): Promise<void> {
    // SQLite is initialized on first DB access
  }

  /**
   * Create a new session
   */
  async createSession(metadata?: Record<string, unknown>): Promise<SessionInfo> {
    return this.store.create(metadata);
  }

  /**
   * Get session info (without messages)
   */
  getSessionInfo(session: SessionStore): SessionInfo {
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
    };
  }

  /**
   * Load session from storage
   */
  async loadSession(sessionId: string): Promise<SessionStore | null> {
    return this.store.load(sessionId);
  }

  /**
   * Save session (no-op for SQLite, persistence is automatic)
   */
  async saveSession(_session: SessionStore): Promise<void> {
    // SQLite handles persistence automatically
  }

  /**
   * Save current session (no-op for SQLite)
   */
  async saveCurrentSession(): Promise<void> {
    // SQLite handles persistence automatically
  }

  /**
   * Get current session
   */
  getCurrentSession(): SessionStore | null {
    return this.store.getCurrent();
  }

  /**
   * Add message to current session
   */
  async addMessage(message: Message): Promise<void> {
    this.store.addMessage(message);
  }

  /**
   * Get messages from current session
   */
  getMessages(): Message[] {
    return this.store.getMessages();
  }

  /**
   * Clear messages in current session
   */
  async clearMessages(): Promise<void> {
    this.store.clearMessages();
  }

  /**
   * Estimate token count for content
   */
  estimateTokens(content: string | MessageContent[]): TokenEstimate {
    let text = '';

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // Handle MessageContent array (TextContent has 'text', others serialize)
      text = content
        .map((m) => {
          if (m.type === 'text') {
            return m.text;
          }
          return JSON.stringify(m);
        })
        .join('\n');
    }

    const totalTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

    return {
      totalTokens,
      canAddMore: totalTokens < this.maxTokensPerMessage,
      needsCompression: totalTokens > this.maxTokensPerMessage * 0.9,
    };
  }

  /**
   * Compress message history (placeholder - compression handled at API level)
   */
  async compressHistory(): Promise<void> {
    // Compression is handled by the API route when needed
  }

  /**
   * Check if context window is getting full
   */
  getContextStatus(): {
    messageCount: number;
    estimatedTokens: number;
    percentFull: number;
    needsCompression: boolean;
  } {
    const current = this.store.getCurrent();
    if (!current) {
      return {
        messageCount: 0,
        estimatedTokens: 0,
        percentFull: 0,
        needsCompression: false,
      };
    }

    const messages = current.messages;
    let totalChars = 0;

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else {
        totalChars += JSON.stringify(msg.content).length;
      }
    }

    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    const percentFull = (estimatedTokens / this.maxTokensPerMessage) * 100;

    return {
      messageCount: messages.length,
      estimatedTokens,
      percentFull: Math.min(percentFull, 100),
      needsCompression: estimatedTokens > this.maxTokensPerMessage * 0.8,
    };
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<SessionInfo[]> {
    return this.store.list();
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  /**
   * Close current session
   */
  async closeSession(): Promise<void> {
    this.store.close();
  }
}

// Export singleton instance for backward compatibility
export const defaultSessionManager = new SessionManager();

export default SessionManager;
