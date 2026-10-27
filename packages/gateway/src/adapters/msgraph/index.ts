/**
 * Microsoft Graph change-notification channel (inbound only).
 *
 * Graph subscriptions push a batch of `{value:[…]}` notifications to an HTTPS
 * endpoint. Two protocol details are easy to get wrong and are handled here:
 * - the subscription handshake is a **GET with `validationToken`** that must be
 *   echoed as `text/plain` (not JSON, not HTML-escaped),
 * - every notification carries the `clientState` secret chosen at subscription
 *   time; a request whose `clientState` does not match must be rejected, and a
 *   batch where *no* notification authenticates is a 403.
 *
 * The channel does not send messages: Graph replies belong to the subscribed
 * resource (a Teams channel, a mailbox) and require a separate credential this
 * adapter does not own.
 */

import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { registerAdapterFactory } from '../base.js';
import { timingSafeEqualStr } from '../shared/signature.js';
import { BoundedIdSet } from '../shared/dedup.js';
import { WebhookServer, type WebhookRequest, type WebhookResponse } from '../shared/webhook-server.js';

const DEFAULT_PORT = 8646;
const DEFAULT_PATH = '/msgraph/webhook';
const MAX_BODY_BYTES = 512 * 1024;

export interface MsGraphOptions {
  port?: number;
  host?: string;
  path?: string;
  /** Only accept notifications whose `resource` starts with one of these. */
  accepted_resources?: string[];
  /** Required when the listener is not bound to loopback. */
  allowed_source_cidrs?: string[];
  prompt?: string;
}

interface GraphNotification {
  id?: string;
  subscriptionId?: string;
  clientState?: string;
  resource?: string;
  changeType?: string;
  tenantId?: string;
}

export class MsGraphAdapter extends BaseAdapter {
  readonly platform = 'msgraph' as const;

  private clientState = '';
  private acceptedResources: string[] = [];
  private allowedCidrs: string[] = [];
  private promptTemplate = '';
  private server: WebhookServer | null = null;
  private readonly seen = new BoundedIdSet({ capacity: 5000, ttlMs: 60 * 60_000 });

  constructor() {
    super({ rateLimitMs: 0 });
    registerAdapterFactory('msgraph', () => new MsGraphAdapter());
  }

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.clientState = (config.credentials['client_state'] ?? '').trim();
    if (!this.clientState) {
      throw new Error('Microsoft Graph channel requires the subscription clientState');
    }

    const options = (config.options ?? {}) as MsGraphOptions;
    this.acceptedResources = options.accepted_resources ?? [];
    this.allowedCidrs = options.allowed_source_cidrs ?? [];
    this.promptTemplate = options.prompt ?? '';

    const host = options.host ?? '127.0.0.1';
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!loopback && this.allowedCidrs.length === 0) {
      // Binding to all interfaces without a source filter turns an authenticated
      // endpoint into one any host on the network can probe.
      throw new Error('Microsoft Graph channel bound to a non-loopback host requires allowed_source_cidrs');
    }

    this.config = config;
    this.server = new WebhookServer({
      port: options.port ?? DEFAULT_PORT,
      host,
      paths: [options.path ?? DEFAULT_PATH],
      maxBodyBytes: MAX_BODY_BYTES,
      onRequest: (req) => this.handleRequest(req),
      onError: (err) => this.updateHealthError(err),
    });
    await this.server.listen();

    this.running = true;
    this.updateHealthConnected();
    this.setBotUsername('msgraph');
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

  async sendReply(_chatId: string, _reply: NormalizedReply): Promise<SendResult> {
    return { ok: false, error: 'msgraph channel is inbound-only' };
  }

  private async handleRequest(req: WebhookRequest): Promise<WebhookResponse> {
    if (req.method === 'GET') {
      const token = req.query.get('validationToken');
      if (!token) {
        // A bare GET would confirm the endpoint exists to a scanner.
        return { status: 400, body: 'validationToken required', contentType: 'text/plain' };
      }
      return { status: 200, body: token, contentType: 'text/plain' };
    }

    if (req.method !== 'POST') {
      return { status: 405, body: 'method not allowed', contentType: 'text/plain' };
    }

    if (this.allowedCidrs.length > 0 && !this.sourceAllowed(req.remoteAddress)) {
      return { status: 403, body: 'source not allowed', contentType: 'text/plain' };
    }

    let payload: { value?: GraphNotification[] };
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as { value?: GraphNotification[] };
    } catch {
      return { status: 400, body: 'invalid json', contentType: 'text/plain' };
    }

    const notifications = payload.value ?? [];
    if (notifications.length === 0) {
      return { status: 400, body: 'empty notification batch', contentType: 'text/plain' };
    }

    let authenticated = 0;
    let duplicates = 0;
    let accepted = 0;

    for (const notification of notifications) {
      if (!this.clientStateMatches(notification.clientState)) continue;
      authenticated += 1;

      const id = notification.id ?? this.syntheticId(notification);
      if (!this.seen.add(id)) {
        duplicates += 1;
        continue;
      }

      if (!this.resourceAccepted(notification.resource)) continue;

      accepted += 1;
      this.deliver(notification);
    }

    if (authenticated === 0) {
      return { status: 403, body: 'clientState mismatch', contentType: 'text/plain' };
    }
    return {
      status: accepted > 0 || duplicates > 0 ? 202 : 400,
      body: JSON.stringify({ accepted, duplicates }),
      contentType: 'application/json',
    };
  }

  private deliver(notification: GraphNotification): void {
    this.incrementMessageCount();
    const subscription = notification.subscriptionId ?? 'default';
    const text = this.promptTemplate
      ? this.promptTemplate
        .replace(/\{notification\.resource\}/g, notification.resource ?? '')
        .replace(/\{notification\.change_type\}/g, notification.changeType ?? '')
        .replace(/\{notification\.subscription_id\}/g, subscription)
        .replace(/\{resource\}/g, notification.resource ?? '')
        .replace(/\{change_type\}/g, notification.changeType ?? '')
        .replace(/\{subscription_id\}/g, subscription)
      : [
        'Microsoft Graph change notification:',
        `- resource: ${notification.resource ?? 'unknown'}`,
        `- changeType: ${notification.changeType ?? 'unknown'}`,
        `- subscription: ${subscription}`,
      ].join('\n');

    const normalized: NormalizedMessage = {
      platform: 'msgraph',
      platformUserId: notification.tenantId ?? 'msgraph',
      platformChatId: `msgraph:${subscription}`,
      platformMsgId: notification.id ?? this.syntheticId(notification),
      text,
      ts: Date.now(),
    };
    this.messageHandler?.(normalized);
  }

  private clientStateMatches(provided: string | undefined): boolean {
    if (!provided) return false;
    return timingSafeEqualStr(this.clientState, provided);
  }

  private resourceAccepted(resource: string | undefined): boolean {
    if (this.acceptedResources.length === 0) return true;
    if (!resource) return false;
    const normalized = resource.replace(/^\//, '');
    return this.acceptedResources.some((pattern) => {
      const clean = pattern.replace(/^\//, '');
      if (clean.endsWith('*')) return normalized.startsWith(clean.slice(0, -1));
      return normalized === clean || normalized.startsWith(`${clean}/`);
    });
  }

  private sourceAllowed(remoteAddress: string): boolean {
    const address = remoteAddress.replace(/^::ffff:/, '');
    return this.allowedCidrs.some((cidr) => ipv4InCidr(address, cidr) || address === cidr);
  }

  private syntheticId(notification: GraphNotification): string {
    return `sha1:${notification.resource ?? '-'}:${notification.changeType ?? '-'}:${notification.subscriptionId ?? '-'}`;
  }
}

/** IPv4 CIDR containment; non-IPv4 inputs only match on exact equality. */
export function ipv4InCidr(address: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  if (!network || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const toInt = (value: string): number | null => {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let result = 0;
    for (const part of parts) {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
      result = (result << 8) | octet;
    }
    return result >>> 0;
  };

  const ip = toInt(address);
  const base = toInt(network);
  if (ip === null || base === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

new MsGraphAdapter();
