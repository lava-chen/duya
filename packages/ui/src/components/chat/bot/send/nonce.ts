/**
 * Plan 491 P1.1: Nonce-based deduplication for bot-direct messages.
 *
 * Uses content hash + time window to deduplicate messages.
 * Targeting acceptance ledger semantics from grok-bot.
 */

import type { MessageDelivery } from '@/types/message';

/** A nonce is a hash of the content + timestamp window. */
export type Nonce = string;

/** Deduplication entry tracking content hash and expiry. */
interface DedupEntry {
  nonce: Nonce;
  expiresAt: number;
  messageId: string;
}

/** Nonce deduplication store with time-window expiry. */
export class NonceDedup {
  private entries = new Map<string, DedupEntry>();
  private readonly windowMs: number;

  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
  }

  /**
   * Generate a nonce from content.
   * Uses a simple hash - in production, use a stronger hash function.
   */
  generateNonce(content: string): Nonce {
    // Simple hash for now - use crypto.subtle in production
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `nonce_${Math.abs(hash).toString(16)}_${Date.now()}`;
  }

  /**
   * Check if a nonce already exists (not expired).
   * Returns the existing message ID if found, null otherwise.
   */
  check(nonce: Nonce): string | null {
    const entry = this.entries.get(nonce);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(nonce);
      return null;
    }

    return entry.messageId;
  }

  /**
   * Register a nonce with an associated message ID.
   */
  register(nonce: Nonce, messageId: string): void {
    this.entries.set(nonce, {
      nonce,
      messageId,
      expiresAt: Date.now() + this.windowMs,
    });
  }

  /**
   * Clean up expired entries.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(nonce);
      }
    }
  }
}

/** Singleton instance for the application lifetime. */
export const nonceDedup = new NonceDedup();
