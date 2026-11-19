/**
 * socket.ts — one Discord gateway WebSocket session, fenced by generation.
 *
 * Scope of this file is the wire protocol only: identify / resume, heartbeat and
 * ACK tracking, reconnect with backoff, and the fatal close codes. It knows
 * nothing about Projects, bindings, or authorization — the owner above it
 * decides what a dispatch means, and `isCurrent()` lets that owner retroactively
 * disown a session whose generation was replaced.
 *
 * Deliberate differences from `DiscordAdapter` (which keeps serving the legacy
 * Bot path untouched):
 *
 * - No `DIRECT_MESSAGES` intent. The port's contract is guild text channels
 *   only, so DMs cannot even arrive instead of being filtered after the fact.
 * - No slash-command bypass. `checkMention` treats `/foo` as a mention; a
 *   project channel must require a real native mention, so that rule is not
 *   reused here.
 * - Reconnect uses exponential backoff with jitter and only resumes a session
 *   whose sequence is still valid; the legacy adapter reconnects at a fixed
 *   5000 ms and always re-identifies.
 * - A heartbeat that misses its ACK closes the socket (4000) and drops the
 *   session, instead of heartbeating into a zombie connection forever.
 */

import type { ProjectChannelErrorCode } from '@duya/agent-protocol/project-channels';
import type { DiscordPayload } from './types.js';
import type { DiscordTimers } from './timers.js';

/**
 * GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT.
 *
 * MESSAGE_CONTENT is privileged and must also be enabled in the Developer
 * Portal; without it the platform blanks `content`, and the owner drops the
 * event rather than guessing (see `connection.ts`).
 */
export const PROJECT_DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const GATEWAY_QUERY = '?v=10&encoding=json';
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Close codes Discord documents as permanent for this connection. */
const FATAL_CLOSE_CODES: ReadonlyMap<number, ProjectChannelErrorCode> = new Map([
  [4004, 'credential_invalid'],
  [4010, 'invalid_target'],
  [4011, 'invalid_target'],
  [4013, 'invalid_request'],
  [4014, 'invalid_request'],
]);

export interface DiscordSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ReconnectPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fractional spread applied symmetrically, e.g. 0.2 for +/-20%. */
  readonly jitterRatio: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
};

export interface DiscordSocketSessionOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly token: string;
  /** Base gateway URL, without the `?v=10` query. */
  readonly gatewayUrl: string;
  readonly createSocket: (url: string) => DiscordSocketLike;
  readonly timers: DiscordTimers;
  readonly policy: ReconnectPolicy;
  readonly onDispatch: (eventType: string, data: unknown) => void;
  /**
   * Runtime state changes only. `connecting` is deliberately absent: an
   * observation says what the platform confirmed, not what we are attempting.
   */
  readonly onState: (
    state: 'connected' | 'disconnected' | 'error',
    errorCode: ProjectChannelErrorCode | null,
  ) => void;
  /** False once the owner replaced or stopped this generation. */
  readonly isCurrent: () => boolean;
  /** Injectable for deterministic backoff assertions. */
  readonly random?: () => number;
}

export class DiscordSocketSession {
  private readonly options: DiscordSocketSessionOptions;
  private socket: DiscordSocketLike | null = null;
  private heartbeatHandle: unknown = null;
  private reconnectHandle: unknown = null;
  private heartbeatIntervalMs = 0;
  private awaitingHeartbeatAck = false;
  private lastSequence: number | null = null;
  private sessionId = '';
  private resumeUrl = '';
  private attempts = 0;
  private stopped = false;

  constructor(options: DiscordSocketSessionOptions) {
    this.options = options;
  }

  get connectionId(): string {
    return this.options.connectionId;
  }

  get generation(): number {
    return this.options.generation;
  }

  /** Opens the socket. Resolution means "attempt started", not "identified". */
  start(): void {
    this.stopped = false;
    this.open(false);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    this.dropSession();
    try {
      socket?.close(1000, 'project channel stopped');
    } catch {
      // A socket that is already torn down is the desired end state.
    }
  }

  private open(resume: boolean): void {
    if (this.stopped || !this.options.isCurrent()) return;

    const base = resume && this.resumeUrl ? this.resumeUrl : this.options.gatewayUrl;
    const socket = this.options.createSocket(`${base}${GATEWAY_QUERY}`);
    this.socket = socket;

    socket.onopen = () => {
      // HELLO drives identify/resume; opening alone proves nothing.
    };

    socket.onmessage = (event) => {
      if (!this.isLive(socket)) return;
      let payload: DiscordPayload;
      try {
        payload = JSON.parse(String(event.data)) as DiscordPayload;
      } catch {
        return;
      }
      this.handlePayload(socket, payload);
    };

    socket.onclose = (event) => {
      this.handleClose(socket, event.code);
    };

    socket.onerror = () => {
      // A close always follows; reconnecting from here would double-open.
    };
  }

  /** Identity plus generation: either being wrong disowns the callback. */
  private isLive(socket: DiscordSocketLike): boolean {
    return this.socket === socket && !this.stopped && this.options.isCurrent();
  }

  private handlePayload(socket: DiscordSocketLike, payload: DiscordPayload): void {
    if (typeof payload.s === 'number') this.lastSequence = payload.s;

    switch (payload.op) {
      case OP_HELLO: {
        const hello = payload.d as { heartbeat_interval?: number } | undefined;
        this.startHeartbeat(hello?.heartbeat_interval ?? 0);
        if (this.canResume()) this.sendResume(socket);
        else this.sendIdentify(socket);
        break;
      }
      case OP_HEARTBEAT_ACK:
        this.awaitingHeartbeatAck = false;
        break;
      case OP_DISPATCH:
        this.handleDispatch(payload.t ?? '', payload.d);
        break;
      case OP_RECONNECT:
        this.reconnectNow(socket, 4000);
        break;
      case OP_INVALID_SESSION: {
        // `d: true` means resumable; anything else must identify from scratch.
        if (payload.d !== true) this.dropSession();
        this.reconnectNow(socket, 4000);
        break;
      }
      default:
        break;
    }
  }

  private handleDispatch(eventType: string, data: unknown): void {
    if (eventType === 'READY') {
      const ready = data as { session_id?: string; resume_gateway_url?: string } | undefined;
      this.sessionId = ready?.session_id ?? '';
      this.resumeUrl = ready?.resume_gateway_url ?? '';
      this.attempts = 0;
      this.options.onState('connected', null);
    } else if (eventType === 'RESUMED') {
      this.attempts = 0;
      this.options.onState('connected', null);
    }

    // The owner sees READY/RESUMED too: it must compare the reported Bot user
    // against the identity it verified over REST before trusting the session.
    this.options.onDispatch(eventType, data);
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatIntervalMs = intervalMs || 41_250;
    this.awaitingHeartbeatAck = false;
    this.heartbeatHandle = this.options.timers.setInterval(() => {
      if (this.awaitingHeartbeatAck) {
        // Zombie: the platform stopped answering. Drop the session instead of
        // resuming a sequence the platform has already forgotten.
        this.dropSession();
        const socket = this.socket;
        if (socket) this.reconnectNow(socket, 4000);
        return;
      }
      this.socket?.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSequence }));
      this.awaitingHeartbeatAck = true;
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.options.timers.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    this.awaitingHeartbeatAck = false;
  }

  private sendIdentify(socket: DiscordSocketLike): void {
    socket.send(
      JSON.stringify({
        op: OP_IDENTIFY,
        d: {
          token: this.options.token,
          intents: PROJECT_DISCORD_INTENTS,
          properties: { os: 'linux', browser: 'duya-project-channel', device: 'duya-project-channel' },
        },
      }),
    );
  }

  private canResume(): boolean {
    return this.sessionId !== '' && this.lastSequence !== null;
  }

  private sendResume(socket: DiscordSocketLike): void {
    socket.send(
      JSON.stringify({
        op: OP_RESUME,
        d: { token: this.options.token, session_id: this.sessionId, seq: this.lastSequence },
      }),
    );
  }

  private reconnectNow(socket: DiscordSocketLike, code: number): void {
    this.clearHeartbeat();
    this.socket = null;
    try {
      socket.close(code, 'reconnect');
    } catch {
      // Already closed.
    }
    this.scheduleReconnect();
  }

  private handleClose(socket: DiscordSocketLike, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearHeartbeat();
    this.clearReconnect();
    if (this.stopped || !this.options.isCurrent()) return;

    const fatal = FATAL_CLOSE_CODES.get(code);
    if (fatal) {
      this.options.onState('error', fatal);
      return;
    }

    this.options.onState('disconnected', null);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.options.isCurrent()) return;
    this.clearReconnect();

    this.attempts += 1;
    const exponential = Math.min(
      this.options.policy.maxDelayMs,
      this.options.policy.baseDelayMs * 2 ** (this.attempts - 1),
    );
    const random = this.options.random ?? Math.random;
    const spread = exponential * this.options.policy.jitterRatio;
    const delay = Math.max(0, Math.round(exponential + (random() * 2 - 1) * spread));

    this.reconnectHandle = this.options.timers.setTimeout(() => {
      this.reconnectHandle = null;
      if (this.stopped || !this.options.isCurrent()) return;
      this.open(this.canResume());
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.options.timers.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private dropSession(): void {
    this.sessionId = '';
    this.resumeUrl = '';
    this.lastSequence = null;
    this.clearHeartbeat();
  }
}
