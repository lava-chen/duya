/**
 * Generic inbound webhook channel.
 *
 * Purpose: let any external system (GitHub/GitLab CI, monitoring, a cron job,
 * an internal service) wake the agent without writing a bespoke adapter first.
 * The channel is inbound-only by design — the reply goes back through the tool
 * or service the workflow already uses.
 *
 * Security posture (deliberately strict):
 * - a signing secret is mandatory; `scheme: "none"` is only accepted when the
 *   listener is bound to loopback,
 * - the signature is verified over the raw body before JSON parsing,
 * - the generic timestamped scheme has a replay window,
 * - every route has a per-minute request cap so a misbehaving sender cannot
 *   spawn unbounded agent turns.
 */

import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { registerAdapterFactory } from '../base.js';
import { BoundedIdSet } from '../shared/dedup.js';
import {
  verifyHubSignature,
  verifyStandardWebhooks,
  verifyTimestampedSignature,
  verifySharedToken,
} from '../shared/signature.js';
import { WebhookServer, headerValue, type WebhookRequest, type WebhookResponse } from '../shared/webhook-server.js';
import { matchesFilters, renderTemplate, defaultPrompt } from './filters.js';

const DEFAULT_PORT = 8644;
const DEFAULT_ROUTE = 'default';
const DEFAULT_MAX_BODY_MB = 5;
const REQUESTS_PER_MINUTE = 30;

export type WebhookSignatureScheme =
  | 'standard'
  | 'github'
  | 'timestamped'
  | 'token'
  | 'none';

export interface WebhookChannelOptions {
  port?: number;
  host?: string;
  route?: string;
  scheme?: WebhookSignatureScheme;
  filters?: unknown;
  /** Prompt template; falls back to a fenced JSON dump. */
  prompt?: string;
  max_body_mb?: number;
}

export class WebhookAdapter extends BaseAdapter {
  readonly platform = 'webhook' as const;

  private secret = '';
  private route = DEFAULT_ROUTE;
  private scheme: WebhookSignatureScheme = 'standard';
  private filters: unknown;
  private promptTemplate = '';
  private server: WebhookServer | null = null;

  private readonly seenDeliveries = new BoundedIdSet({ capacity: 2000, ttlMs: 60 * 60_000 });
  private rateWindowStart = 0;
  private rateWindowCount = 0;

  constructor() {
    super({ rateLimitMs: 0 });
    registerAdapterFactory('webhook', () => new WebhookAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    const options = (config.options ?? {}) as WebhookChannelOptions;
    this.secret = (config.credentials['secret'] ?? '').trim();
    this.route = (config.credentials['route'] ?? options.route ?? DEFAULT_ROUTE).trim() || DEFAULT_ROUTE;
    this.scheme = options.scheme ?? 'standard';
    this.filters = options.filters;
    this.promptTemplate = options.prompt ?? '';

    const host = options.host ?? '127.0.0.1';
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

    if (this.scheme === 'none') {
      if (!loopback) {
        throw new Error('webhook channel with scheme "none" must bind to loopback');
      }
    } else if (!this.secret) {
      throw new Error('webhook channel requires a signing secret');
    }

    this.config = config;
    this.server = new WebhookServer({
      port: options.port ?? DEFAULT_PORT,
      host,
      paths: [`/webhooks/${this.route}`],
      maxBodyBytes: Math.max(1, options.max_body_mb ?? DEFAULT_MAX_BODY_MB) * 1024 * 1024,
      onRequest: (req) => this.handleRequest(req),
      onError: (err) => this.updateHealthError(err),
    });
    await this.server.listen();

    this.running = true;
    this.updateHealthConnected();
    this.setBotUsername(`webhook:${this.route}`);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.server) return;
    this.running = false;
    this.health.connected = false;
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Inbound-only channel: the workflow owns the outbound path. */
  async sendReply(_chatId: string, _reply: NormalizedReply): Promise<SendResult> {
    return { ok: false, error: 'webhook channel is inbound-only' };
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private async handleRequest(req: WebhookRequest): Promise<WebhookResponse> {
    if (req.method !== 'POST') {
      return { status: 405, body: 'method not allowed', contentType: 'text/plain' };
    }

    const expectedPath = `/webhooks/${this.route}`;
    if (req.path !== expectedPath) {
      return { status: 404, body: 'unknown route', contentType: 'text/plain' };
    }

    if (!this.verify(req)) {
      return { status: 401, body: 'signature verification failed', contentType: 'text/plain' };
    }

    if (!this.consumeRateBudget()) {
      return { status: 429, body: 'too many requests', contentType: 'text/plain' };
    }

    let payload: unknown;
    try {
      payload = req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : {};
    } catch {
      return { status: 400, body: 'invalid json', contentType: 'text/plain' };
    }

    const headers = lowerHeaders(req.headers);
    if (!matchesFilters(this.filters, payload, headers)) {
      return { status: 202, body: '{"accepted":false,"reason":"filtered"}', contentType: 'application/json' };
    }

    const deliveryId = this.deliveryId(req, headers);
    if (!this.seenDeliveries.add(deliveryId)) {
      return { status: 202, body: '{"accepted":false,"reason":"duplicate"}', contentType: 'application/json' };
    }

    this.incrementMessageCount();

    const text = this.promptTemplate
      ? renderTemplate(this.promptTemplate, payload, headers)
      : defaultPrompt(payload);

    const normalized: NormalizedMessage = {
      platform: 'webhook',
      platformUserId: headers['x-webhook-sender'] ?? this.route,
      // One persistent session per route: a per-delivery session would create a
      // new chat for every event and destroy conversational continuity.
      platformChatId: `webhook:${this.route}`,
      platformMsgId: deliveryId,
      text,
      ts: Date.now(),
    };

    this.messageHandler?.(normalized);
    return { status: 202, body: '{"accepted":true}', contentType: 'application/json' };
  }

  private verify(req: WebhookRequest): boolean {
    const headers = req.headers;
    switch (this.scheme) {
      case 'none':
        return true;

      case 'github':
        return verifyHubSignature(
          this.secret,
          req.rawBody,
          headerValue(headers, 'x-hub-signature-256'),
        );

      case 'standard':
        return verifyStandardWebhooks(this.secret, req.rawBody, {
          id: headerValue(headers, 'webhook-id') ?? headerValue(headers, 'svix-id'),
          timestamp: headerValue(headers, 'webhook-timestamp') ?? headerValue(headers, 'svix-timestamp'),
          signature: headerValue(headers, 'webhook-signature') ?? headerValue(headers, 'svix-signature'),
        });

      case 'timestamped':
        return verifyTimestampedSignature(
          this.secret,
          req.rawBody,
          headerValue(headers, 'x-webhook-signature'),
          headerValue(headers, 'x-webhook-timestamp'),
        );

      case 'token':
        return verifySharedToken(
          this.secret,
          headerValue(headers, 'x-gitlab-token') ?? headerValue(headers, 'x-webhook-token'),
        );

      default:
        return false;
    }
  }

  private consumeRateBudget(): boolean {
    const now = Date.now();
    if (now - this.rateWindowStart >= 60_000) {
      this.rateWindowStart = now;
      this.rateWindowCount = 0;
    }
    this.rateWindowCount += 1;
    return this.rateWindowCount <= REQUESTS_PER_MINUTE;
  }

  private deliveryId(req: WebhookRequest, headers: Record<string, string>): string {
    return (
      headers['x-github-delivery'] ??
      headers['webhook-id'] ??
      headers['svix-id'] ??
      headers['x-request-id'] ??
      headers['x-gitlab-event-uuid'] ??
      `${Date.now()}-${req.rawBody.length}`
    );
  }
}

function lowerHeaders(headers: WebhookRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value[0] ?? '';
  }
  return out;
}

new WebhookAdapter();
