import WebSocket from 'ws';
import type { FeishuDomain } from './types';

const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_BACKOFF_MS = 120000;
const NORMAL_RECONNECT_INTERVAL_MS = 120000;
const NON_NORMAL_RECONNECT_NONCE_MS = 30000;
const APP_LOCK_FILE = 'feishu_ws_app_lock.txt';

interface WSEvent {
  type: string;
  data: unknown;
}

type WSEventHandler = (event: WSEvent) => void;

interface FeishuWSClientOptions {
  domain: FeishuDomain;
  appId: string;
  appSecret: string;
  onEvent: WSEventHandler;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting') => void;
}

export class FeishuWSClient {
  private _domain: FeishuDomain;
  private _appId: string;
  private _appSecret: string;
  private _ws: WebSocket | null = null;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _pongTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private _shouldReconnect = true;
  private _retryCount = 0;
  private _lastDisconnectTime = 0;
  private _connectionId = '';
  private _onEvent: WSEventHandler;
  private _onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting') => void;
  private _appLockAcquired = false;

  constructor(options: FeishuWSClientOptions) {
    this._domain = options.domain;
    this._appId = options.appId;
    this._appSecret = options.appSecret;
    this._onEvent = options.onEvent;
    this._onStatusChange = options.onStatusChange;
  }

  get domain(): FeishuDomain { return this._domain; }
  get appId(): string { return this._appId; }
  get isConnected(): boolean { return this._ws?.readyState === WebSocket.OPEN; }

  private _acquireAppLock(): boolean {
    try {
      const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || '/tmp';
      const lockDir = require('path').join(home, '.duya', 'gateway');
      require('fs').mkdirSync(lockDir, { recursive: true });
      const lockPath = require('path').join(lockDir, `${this._appId}_${APP_LOCK_FILE}`);
      if (require('fs').existsSync(lockPath)) {
        const age = Date.now() - require('fs').statSync(lockPath).mtimeMs;
        if (age < 60000) {
          return false;
        }
        require('fs').unlinkSync(lockPath);
      }
      require('fs').writeFileSync(lockPath, Date.now().toString(), 'utf-8');
      this._appLockAcquired = true;
      return true;
    } catch {
      return true;
    }
  }

  private _releaseAppLock(): void {
    if (!this._appLockAcquired) return;
    try {
      const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || '/tmp';
      const lockPath = require('path').join(home, '.duya', 'gateway', `${this._appId}_${APP_LOCK_FILE}`);
      if (require('fs').existsSync(lockPath)) {
        require('fs').unlinkSync(lockPath);
      }
    } catch {}
    this._appLockAcquired = false;
  }

  private _getWsUrl(): string {
    const base = this._domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
    return `${base}/open-apis/ws`;
  }

  private _getTokenUrl(): string {
    const base = this._domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
    return `${base}/open-apis/auth/v3/app_access_token/internal`;
  }

  private async _getAccessToken(): Promise<string> {
    const res = await fetch(this._getTokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this._appId, app_secret: this._appSecret }),
    });
    const data = await res.json() as { code: number; msg: string; app_access_token?: string };
    if (data.code !== 0 || !data.app_access_token) {
      throw new Error(`Failed to get access token: ${data.msg || 'unknown error'}`);
    }
    return data.app_access_token;
  }

  private async _getConnectionInfo(): Promise<{ url: string; connection_id: string }> {
    const token = await this._getAccessToken();
    const res = await fetch(this._getWsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await res.json() as { code: number; msg: string; data?: { url?: string; connection_id?: string } };
    if (data.code !== 0 || !data.data?.url) {
      throw new Error(`Failed to get WebSocket connection info: ${data.msg || 'unknown error'}`);
    }
    return { url: data.data.url, connection_id: data.data.connection_id || '' };
  }

  private _resetPingPong(): void {
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  private _startPing(): void {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState !== WebSocket.OPEN) return;
      this._pongTimer = setTimeout(() => {
        this._ws?.terminate();
      }, PONG_TIMEOUT_MS);
      this._ws?.ping();
    }, PING_INTERVAL_MS);
  }

  private _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this._resetPingPong();
  }

  private _handlePong(): void {
    this._resetPingPong();
    this._retryCount = 0;
  }

  private _scheduleReconnect(isNormal: boolean): void {
    if (!this._shouldReconnect || this._reconnectTimer) return;

    const now = Date.now();
    let delay: number;

    if (isNormal) {
      const elapsed = now - this._lastDisconnectTime;
      delay = Math.max(0, NORMAL_RECONNECT_INTERVAL_MS - elapsed);
    } else {
      this._retryCount++;
      const nonce = Math.min(NON_NORMAL_RECONNECT_NONCE_MS * this._retryCount, MAX_RECONNECT_BACKOFF_MS);
      const jitter = Math.random() * (nonce * 0.5);
      delay = nonce + jitter;
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  async connect(): Promise<void> {
    if (!this._acquireAppLock()) {
      return;
    }

    this._shouldReconnect = true;
    this._running = true;

    try {
      this._lastDisconnectTime = Date.now();
      this._onStatusChange?.('connecting');

      const { url, connection_id } = await this._getConnectionInfo();
      this._connectionId = connection_id;

      this._ws = new WebSocket(url);

      this._ws.on('open', () => {
        this._onStatusChange?.('connected');
        this._startPing();
      });

      this._ws.on('pong', () => {
        this._handlePong();
      });

      this._ws.on('message', (data: WebSocket.Data) => {
        try {
          const text = typeof data === 'string' ? data : data.toString();
          const parsed = JSON.parse(text);
          if (parsed.type === 'ping') {
            this._ws?.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (parsed.type === 'message' || parsed.type === 'event') {
            this._onEvent({ type: parsed.type, data: parsed.data });
          }
        } catch {}
      });

      this._ws.on('close', (code: number) => {
        this._stopPing();
        this._onStatusChange?.('disconnected');
        const isNormal = code === 1000 || code === 1001;
        this._scheduleReconnect(isNormal);
      });

      this._ws.on('error', () => {});
    } catch {
      this._onStatusChange?.('reconnecting');
      this._scheduleReconnect(false);
    }
  }

  async disconnect(): Promise<void> {
    this._shouldReconnect = false;
    this._running = false;
    this._stopPing();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws) {
      this._ws.on('close', () => {});
      this._ws.close(1000);
      this._ws = null;
    }

    this._releaseAppLock();
    this._onStatusChange?.('disconnected');
  }

  send(data: unknown): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }
}