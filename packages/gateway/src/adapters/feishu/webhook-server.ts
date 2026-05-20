/**
 * Feishu Webhook Server
 *
 * Handles inbound Feishu events via HTTP webhook callback.
 * Implements multi-layer security: rate limiting, signature verification,
 * verification token check, and event routing.
 */

import http from 'http';
import crypto from 'crypto';
import type { FeishuAdapter } from './index.js';
import type { FeishuEvent } from './types.js';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface WebhookConfig {
  host: string;
  port: number;
  path: string;
  verificationToken: string;
  encryptKey: string;
}

/** 120 requests per 60 seconds per (app_id:path:ip) */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const BODY_READ_TIMEOUT_MS = 30_000;
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

export class FeishuWebhookServer {
  private server: http.Server | null = null;
  private adapter: FeishuAdapter;
  private config: WebhookConfig;
  private rateLimitMap = new Map<string, RateLimitEntry>();
  private anomalyCount = 0;
  private lastAnomalyReportAt = 0;

  constructor(adapter: FeishuAdapter, config: WebhookConfig) {
    this.adapter = adapter;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        console.log(`[Feishu] Webhook server listening on ${this.config.host}:${this.config.port}${this.config.path}`);
        resolve();
      });

      this.server!.on('error', (err) => {
        console.error('[Feishu] Webhook server error:', err);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        console.log('[Feishu] Webhook server stopped');
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientIp = this.getClientIp(req);
    const key = `${this.config.path}:${clientIp}`;

    // Rate limiting
    if (!this.checkRateLimit(key)) {
      this.recordAnomaly('rate_limit', clientIp);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 429, msg: 'Too many requests' }));
      return;
    }

    // Content-Type guard
    const contentType = req.headers['content-type'] ?? '';
    if (contentType !== 'application/json') {
      this.recordAnomaly('invalid_content_type', clientIp);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 400, msg: 'Content-Type must be application/json' }));
      return;
    }

    // Content-Length guard (pre-check)
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_BODY_SIZE) {
      this.recordAnomaly('body_too_large', clientIp);
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 413, msg: 'Payload too large' }));
      return;
    }

    // Read body with timeout
    const body = await this.readBody(req);
    if (body === null) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 408, msg: 'Request timeout' }));
      return;
    }

    // Body size post-check
    if (body.length > MAX_BODY_SIZE) {
      this.recordAnomaly('body_too_large', clientIp);
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 413, msg: 'Payload too large' }));
      return;
    }

    // Parse JSON
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 400, msg: 'Invalid JSON' }));
      return;
    }

    // URL verification challenge
    if (this.isUrlVerification(payload)) {
      const challenge = (payload as { challenge?: string }).challenge ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge }));
      return;
    }

    // Verification token check
    if (!this.verifyVerificationToken(payload)) {
      this.recordAnomaly('invalid_token', clientIp);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 401, msg: 'Invalid verification token' }));
      return;
    }

    // Signature verification
    const signature = req.headers['x-lark-signature'] as string | undefined;
    const timestamp = req.headers['x-lark-timestamp'] as string | undefined;
    if (signature && timestamp && !this.verifySignature(signature, timestamp, body)) {
      this.recordAnomaly('invalid_signature', clientIp);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 401, msg: 'Invalid signature' }));
      return;
    }

    // Route event
    await this.routeEvent(payload);

    // Respond immediately (Feishu expects quick acknowledgment)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, msg: 'success' }));
  }

  private checkRateLimit(key: string): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(key);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      // Clean up old entries periodically to prevent unbounded growth
      if (this.rateLimitMap.size > 4096) {
        this.cleanupExpiredRateLimits(now);
      }
      this.rateLimitMap.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= RATE_LIMIT_MAX) {
      return false;
    }

    entry.count++;
    return true;
  }

  private cleanupExpiredRateLimits(now: number): void {
    let cleaned = 0;
    for (const [key, entry] of this.rateLimitMap.entries()) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        this.rateLimitMap.delete(key);
        cleaned++;
        if (cleaned > 100) break; // Limit cleanup per request
      }
    }
    console.log(`[Feishu] Rate limit cleanup: removed ${cleaned} expired entries`);
  }

  private readBody(req: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, BODY_READ_TIMEOUT_MS);

      const chunks: Buffer[] = [];

      const cleanup = () => {
        clearTimeout(timeout);
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
      };

      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunks.reduce((sum, b) => sum + b.length, 0) > MAX_BODY_SIZE) {
          cleanup();
          resolve(null);
        }
      };

      const onEnd = () => {
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf8'));
      };

      const onError = () => {
        cleanup();
        resolve(null);
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });
  }

  private isUrlVerification(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const p = payload as Record<string, unknown>;
    return p.type === 'url_verification';
  }

  private verifyVerificationToken(payload: unknown): boolean {
    if (!this.config.verificationToken) return true;
    if (!payload || typeof payload !== 'object') return false;

    const p = payload as Record<string, unknown>;
    const token = p.token as string | undefined;

    if (!token) return false;

    // Timing-safe comparison
    const a = Buffer.from(this.config.verificationToken);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private verifySignature(signature: string, timestamp: string, body: string): boolean {
    if (!this.config.encryptKey) return true;

    // Use HMAC-SHA256: sha256(timestamp + encryptKey + body)
    // With encryptKey as the HMAC secret
    const hmac = crypto.createHmac('sha256', this.config.encryptKey);
    hmac.update(timestamp + this.config.encryptKey + body);
    const hash = hmac.digest('hex');

    // Timing-safe comparison
    const a = Buffer.from(hash);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private async routeEvent(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') return;

    const event = payload as FeishuEvent;

    // Route by event_type
    switch (event.header?.event_type) {
      case 'im.message.receive_v1':
        this.adapter.handleInboundMessage(event.event);
        break;

      case 'im.message.reaction.created_v1':
        this.adapter.handleReactionCreated(event);
        break;

      case 'im.message.reaction.deleted_v1':
        this.adapter.handleReactionDeleted(event);
        break;

      case 'im.chat.member.bot.added_v1':
        this.adapter.handleBotAddedToChat(event);
        break;

      case 'im.chat.member.bot.deleted_v1':
        this.adapter.handleBotRemovedFromChat(event);
        break;

      case 'im.message.recalled_v1':
        this.adapter.handleMessageRecalled(event);
        break;

      case 'p2p_chat_entered_v1':
        this.adapter.handleP2pChatEntered(event);
        break;

      case 'card.action.trigger':
        this.adapter.handleCardAction(event);
        break;

      case 'drive.notice.comment_add_v1':
        await this.adapter.handleDriveComment(event);
        break;

      default:
        console.log(`[Feishu] Unknown event type: ${event.header?.event_type}`);
    }
  }

  private getClientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private recordAnomaly(type: string, ip: string): void {
    this.anomalyCount++;
    const now = Date.now();

    // Log warning every 25 anomalies or after 6 hours since last report
    if (this.anomalyCount % 25 === 0 || now - this.lastAnomalyReportAt > 6 * 60 * 60 * 1000) {
      console.warn(`[Feishu] Webhook anomaly (count=${this.anomalyCount}): ${type} from ${ip}`);
      this.lastAnomalyReportAt = now;
    }
  }
}