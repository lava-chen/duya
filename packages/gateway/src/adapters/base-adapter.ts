/**
 * BaseAdapter - Abstract base class for all platform adapters
 *
 * Extracts common functionality shared across all adapters:
 * - Health tracking
 * - Rate limiting
 * - API calls with proxy support
 * - Message deduplication
 * - Error handling
 */

import type {
  PlatformType,
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
  AdapterHealth,
} from '../types.js';
import type { PlatformAdapter } from './base.js';
import { proxyFetch } from '../proxy-fetch.js';

const DEFAULT_RATE_LIMIT_MS = 3000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DEDUP_CAPACITY = 200;

export interface AdapterHealthState {
  connected: boolean;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  totalMessages: number;
  botUsername?: string;
}

export abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformType;
  protected token = '';
  protected running = false;
  protected config: PlatformConfig | null = null;
  protected botUsername = '';

  // ---------------------------------------------------------------------------
  // Health tracking
  // ---------------------------------------------------------------------------
  protected health: AdapterHealthState = {
    connected: false,
    lastConnectedAt: undefined,
    lastErrorAt: undefined,
    lastError: undefined,
    consecutiveErrors: 0,
    totalMessages: 0,
    botUsername: '',
  };

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------
  protected rateLimitMs: number;
  protected lastSendTime = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Message deduplication
  // ---------------------------------------------------------------------------
  protected recentUpdateIds = new Set<number>();
  protected committedOffset = 0;
  protected dedupCapacity: number;

  // ---------------------------------------------------------------------------
  // Retry configuration
  // ---------------------------------------------------------------------------
  protected maxRetries: number;
  protected baseBackoffMs: number;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  protected messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  protected commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  constructor(options?: {
    rateLimitMs?: number;
    dedupCapacity?: number;
    maxRetries?: number;
    baseBackoffMs?: number;
  }) {
    this.rateLimitMs = options?.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.dedupCapacity = options?.dedupCapacity ?? DEFAULT_DEDUP_CAPACITY;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options?.baseBackoffMs ?? 1000;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (abstract to override)
  // ---------------------------------------------------------------------------
  abstract start(config: PlatformConfig): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;

  // ---------------------------------------------------------------------------
  // Health interface
  // ---------------------------------------------------------------------------
  getHealth(): AdapterHealth {
    return {
      connected: this.running && this.health.connected,
      lastConnectedAt: this.health.lastConnectedAt,
      lastErrorAt: this.health.lastErrorAt,
      lastError: this.health.lastError,
      consecutiveErrors: this.health.consecutiveErrors,
      totalMessages: this.health.totalMessages,
      botUsername: this.botUsername || this.health.botUsername,
    };
  }

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------
  onMessage(handler: (msg: NormalizedMessage) => void): void {
    this.messageHandler = handler;
  }

  setCommandHandler(handler: (msg: NormalizedMessage) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // PlatformAdapter interface (sendReply must be implemented by subclass)
  // ---------------------------------------------------------------------------
  abstract sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult>;
  sendTyping?(chatId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Protected: Rate limiting helpers
  // ---------------------------------------------------------------------------
  protected async waitForRateLimit(chatId: string): Promise<void> {
    const lastTime = this.lastSendTime.get(chatId) ?? 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < this.rateLimitMs) {
      await this.delay(this.rateLimitMs - elapsed);
    }
  }

  protected recordSendTime(chatId: string): void {
    this.lastSendTime.set(chatId, Date.now());
  }

  // ---------------------------------------------------------------------------
  // Protected: Message deduplication helpers
  // ---------------------------------------------------------------------------
  protected markUpdateProcessed(updateId: number): void {
    this.recentUpdateIds.add(updateId);
    while (this.recentUpdateIds.has(this.committedOffset)) {
      this.committedOffset++;
    }
    if (this.recentUpdateIds.size > this.dedupCapacity) {
      for (const id of this.recentUpdateIds) {
        if (id < this.committedOffset - this.dedupCapacity / 2) {
          this.recentUpdateIds.delete(id);
        }
      }
    }
  }

  protected isDuplicate(updateId: number): boolean {
    return this.recentUpdateIds.has(updateId);
  }

  protected getCurrentOffset(): number {
    return this.committedOffset;
  }

  // ---------------------------------------------------------------------------
  // Protected: Error classification
  // ---------------------------------------------------------------------------
  protected isNetworkError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const msg = String((err as Error).message).toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('socket') ||
      msg.includes('abort') ||
      msg.includes('disconnect') ||
      msg.includes('unreachable') ||
      msg.includes('eai_again')
    );
  }

  protected isFloodControlError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const msg = String((err as Error).message).toLowerCase();
    return (
      msg.includes('retry after') ||
      msg.includes('flood control') ||
      msg.includes('429')
    );
  }

  protected isPermanentError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const msg = String((err as Error).message).toLowerCase();
    return (
      msg.includes('unauthorized') ||
      msg.includes('invalid') ||
      msg.includes('deactivated') ||
      msg.includes('forbidden') ||
      msg.includes('not found')
    );
  }

  protected extractRetryAfter(err: unknown): number | null {
    if (!err || typeof err !== 'object') return null;
    const msg = String((err as Error).message);
    const match = msg.match(/retry after (\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  // ---------------------------------------------------------------------------
  // Protected: Retry helper
  // ---------------------------------------------------------------------------
  protected async withRetry<T>(
    operation: () => Promise<T>,
    options?: {
      maxRetries?: number;
      onRetry?: (err: Error, attempt: number) => void;
    }
  ): Promise<T> {
    const maxTries = options?.maxRetries ?? this.maxRetries;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < maxTries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));

        // Flood control: wait and retry
        const retryAfter = this.extractRetryAfter(lastErr);
        if (retryAfter !== null) {
          if (attempt < maxTries - 1) {
            console.warn(`[${this.platform}] Flood control, retrying in ${retryAfter}s`);
            await this.delay(retryAfter * 1000 + 200);
            continue;
          }
        }

        // Network error: exponential backoff
        if (this.isNetworkError(lastErr) && attempt < maxTries - 1) {
          const backoff = Math.min(this.baseBackoffMs * (2 ** attempt), 5000);
          options?.onRetry?.(lastErr, attempt);
          await this.delay(backoff);
          continue;
        }

        throw lastErr;
      }
    }

    throw lastErr ?? new Error('Operation failed after retries');
  }

  // ---------------------------------------------------------------------------
  // Protected: API call with proxy
  // ---------------------------------------------------------------------------
  protected async apiCall<T = unknown>(
    url: string,
    method: string,
    params?: Record<string, unknown>,
    options?: {
      headers?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<T> {
    const response = await proxyFetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: params ? JSON.stringify(params) : undefined,
    });

    const data = await response.json() as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };

    if (!response.ok || !data.ok) {
      const desc = data.description ?? `HTTP ${response.status}`;
      const code = data.error_code ?? response.status;
      const retryAfter = data.parameters?.retry_after;
      const retryPart = retryAfter !== undefined ? ` (retry after ${retryAfter})` : '';
      throw new Error(`API error (${code}): ${desc}${retryPart}`);
    }

    return data.result as T;
  }

  // ---------------------------------------------------------------------------
  // Protected: Health update helpers
  // ---------------------------------------------------------------------------
  protected updateHealthConnected(): void {
    this.health.connected = true;
    this.health.lastConnectedAt = Date.now();
    this.health.consecutiveErrors = 0;
  }

  protected updateHealthError(err: unknown): void {
    this.health.lastErrorAt = Date.now();
    this.health.lastError = err instanceof Error ? err.message : String(err);
    this.health.consecutiveErrors++;
  }

  protected incrementMessageCount(): void {
    this.health.totalMessages++;
  }

  protected setBotUsername(username: string): void {
    this.botUsername = username;
    this.health.botUsername = username;
  }

  // ---------------------------------------------------------------------------
  // Protected: Utility
  // ---------------------------------------------------------------------------
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected cleanMap<K, V>(map: Map<K, V>, timerMap: Map<K, ReturnType<typeof setTimeout>>): void {
    for (const timer of timerMap.values()) {
      clearTimeout(timer);
    }
    timerMap.clear();
    map.clear();
  }
}