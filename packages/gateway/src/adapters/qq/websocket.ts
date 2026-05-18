/**
 * QQ WebSocket connection manager
 */

import type {
  QQWebSocketPayload,
  QQHeartbeat,
  QQIdentify,
} from './types.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export interface WebSocketCallbacks {
  onOpen: () => void;
  onMessage: (payload: QQWebSocketPayload) => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: Event) => void;
}

export class QQWebSocketManager {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private running = false;

  private sessionId = '';
  private sequenceNumber: number | null = null;
  private resumeGatewayUrl = '';
  private heartbeatInterval = HEARTBEAT_INTERVAL_MS;

  private callbacks: WebSocketCallbacks;
  private authHeaderFn: () => string;
  private calculateIntentsFn: () => number;
  private reconnectFn: () => Promise<void>;

  constructor(
    callbacks: WebSocketCallbacks,
    authHeaderFn: () => string,
    calculateIntentsFn: () => number,
    reconnectFn: () => Promise<void>
  ) {
    this.callbacks = callbacks;
    this.authHeaderFn = authHeaderFn;
    this.calculateIntentsFn = calculateIntentsFn;
    this.reconnectFn = reconnectFn;
  }

  connect(gatewayUrl: string): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(gatewayUrl);

      this.ws.onopen = () => {
        console.log('[QQ] WebSocket connected');
        this.reconnectAttempts = 0;
        this.callbacks.onOpen();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data as string) as QQWebSocketPayload;
          this.callbacks.onMessage(payload);
        } catch (err) {
          console.error('[QQ] Failed to parse WebSocket message:', err);
        }
      };

      this.ws.onclose = (event: { code: number; reason: string }) => {
        console.log(`[QQ] WebSocket closed: ${event.code} ${event.reason}`);
        this.cleanup();
        this.callbacks.onClose(event.code, event.reason);
      };

      this.ws.onerror = (err: Event) => {
        console.error('[QQ] WebSocket error:', err);
        this.callbacks.onError(err);
      };
    } catch (err) {
      console.error('[QQ] Failed to create WebSocket:', err);
      this.scheduleReconnect();
    }
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error('[QQ] Max reconnect attempts reached, giving up');
      this.running = false;
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * (2 ** (this.reconnectAttempts - 1)), RECONNECT_MAX_MS);
    console.log(`[QQ] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectFn();
    }, delay);
  }

  handlePayload(payload: QQWebSocketPayload): void {
    switch (payload.op) {
      case 10: // Hello
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;
      case 11: // Heartbeat ACK
        break;
      case 0: // Dispatch
        this.callbacks.onMessage(payload);
        break;
      case 7: // Reconnect
        console.log('[QQ] Server requested reconnect');
        this.ws?.close(1000, 'Server requested reconnect');
        break;
      case 9: // Invalid Session
        console.log('[QQ] Invalid session, clearing session state');
        this.sessionId = '';
        this.sequenceNumber = null;
        this.ws?.close(1000, 'Invalid session');
        break;
      default:
        console.log(`[QQ] Unknown op code: ${payload.op}`);
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    this.heartbeatInterval = data.heartbeat_interval ?? HEARTBEAT_INTERVAL_MS;

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatInterval);

    if (this.sessionId && this.sequenceNumber !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const heartbeat: QQHeartbeat = {
      op: 1,
      d: this.sequenceNumber,
    };

    this.ws.send(JSON.stringify(heartbeat));
  }

  private sendIdentify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const identify: QQIdentify = {
      op: 2,
      d: {
        token: this.authHeaderFn(),
        intents: this.calculateIntentsFn(),
        shard: [0, 1],
        properties: {
          os: process.platform,
          browser: 'duya-gateway',
          device: 'duya-gateway',
        },
      },
    };

    this.ws.send(JSON.stringify(identify));
    console.log('[QQ] Sent identify');
  }

  private sendResume(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const resume = {
      op: 6,
      d: {
        token: this.authHeaderFn(),
        session_id: this.sessionId,
        seq: this.sequenceNumber,
      },
    };

    this.ws.send(JSON.stringify(resume));
    console.log('[QQ] Sent resume');
  }

  setSessionInfo(sessionId: string, seq: number | null, resumeUrl: string): void {
    this.sessionId = sessionId;
    this.sequenceNumber = seq;
    this.resumeGatewayUrl = resumeUrl;
  }

  getResumeGatewayUrl(): string {
    return this.resumeGatewayUrl;
  }

  setSequence(seq: number): void {
    this.sequenceNumber = seq;
  }

  close(code: number, reason: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(code, reason);
  }
}