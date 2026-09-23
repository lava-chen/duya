import WebSocket from 'ws';
import type { FeishuDomain } from './types.js';

/**
 * Feishu/Lark long-connection (长连接) WebSocket client.
 *
 * Wire protocol (verified against the official SDKs — oapi-sdk-go `ws/`
 * and oapi-sdk-python `lark_oapi/ws/client.py`):
 *
 *  1. POST /callback/ws/endpoint {AppID, AppSecret} → {code, data:{URL, ClientConfig}}.
 *     The returned URL embeds `device_id` and `service_id` query params.
 *  2. ALL WebSocket messages are binary protobuf `pbbp2.Frame`s:
 *       field 1 SeqID(varint)  2 LogID(varint)  3 Service(varint)
 *       field 4 Method(varint: CONTROL=0, DATA=1)
 *       field 5 Headers(repeated Header{1 key, 2 value})
 *       field 8 Payload(bytes)
 *     Header keys: "type" ("ping"/"pong"/"event"/"card"), "message_id",
 *     "sum", "seq", "trace_id", "biz_rt", "Handshake-Status", "Handshake-Msg".
 *  3. Client must send an application-level PING CONTROL frame (with
 *     `service` = service_id from the URL) roughly every 30s; the server
 *     answers with a PONG whose payload may carry a ClientConfig update.
 *     Server-originated PINGs need no reply.
 *  4. EVENT DATA frames must be acknowledged by writing the same frame back
 *     with its payload replaced by `{"code":200}` — otherwise the server
 *     treats delivery as failed.
 *
 * NOTE: this is NOT a JSON-text protocol. An earlier revision JSON-parsed
 * every inbound message and silently swallowed the parse failure, which
 * dropped every event frame and made the bot permanently deaf while still
 * reporting "connected".
 */

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_BACKOFF_MS = 120_000;
const NORMAL_RECONNECT_INTERVAL_MS = 120_000;
const NON_NORMAL_RECONNECT_NONCE_MS = 30_000;
const APP_LOCK_FILE = 'feishu_ws_app_lock.txt';

const FRAME_METHOD_CONTROL = 0;
const FRAME_METHOD_DATA = 1;

const MSG_TYPE_PING = 'ping';
const MSG_TYPE_PONG = 'pong';
const MSG_TYPE_EVENT = 'event';
const MSG_TYPE_CARD = 'card';

const HEADER_TYPE = 'type';
const HEADER_MESSAGE_ID = 'message_id';
const HEADER_SUM = 'sum';
const HEADER_SEQ = 'seq';
const HEADER_BIZ_RT = 'biz_rt';
const HEADER_HANDSHAKE_STATUS = 'Handshake-Status';
const HEADER_HANDSHAKE_MSG = 'Handshake-Msg';

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

// ---------------------------------------------------------------------------
// Minimal protobuf codec for pbbp2.Frame (field numbers per oapi-sdk-go
// ws/pbbp2.pb.go). No dependency — the message shape is tiny.
// ---------------------------------------------------------------------------

interface FrameHeader {
  key: string;
  value: string;
}

interface Frame {
  seqId: bigint;
  logId: bigint;
  service: bigint;
  method: number;
  headers: FrameHeader[];
  payload: Buffer;
}

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
    if (shift > 70n) throw new Error('protobuf varint too long');
  }
  throw new Error('protobuf varint truncated');
}

function encodeVarint(value: bigint): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function decodeHeader(bytes: Buffer): FrameHeader {
  let pos = 0;
  let key = '';
  let value = '';
  while (pos < bytes.length) {
    const [tag, p1] = readVarint(bytes, pos);
    pos = p1;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType !== 2) throw new Error(`unexpected wire type ${wireType} in Header`);
    const [len, p2] = readVarint(bytes, pos);
    pos = p2;
    const str = bytes.subarray(pos, pos + Number(len)).toString('utf-8');
    pos += Number(len);
    if (fieldNum === 1) key = str;
    else if (fieldNum === 2) value = str;
  }
  return { key, value };
}

export function decodeFrame(buf: Buffer): Frame | null {
  const frame: Frame = { seqId: 0n, logId: 0n, service: 0n, method: 0, headers: [], payload: Buffer.alloc(0) };
  let pos = 0;
  try {
    while (pos < buf.length) {
      const [tag, p1] = readVarint(buf, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNum >= 1 && fieldNum <= 4) {
        if (wireType !== 0) return null;
        const [v, p2] = readVarint(buf, pos);
        pos = p2;
        if (fieldNum === 1) frame.seqId = v;
        else if (fieldNum === 2) frame.logId = v;
        else if (fieldNum === 3) frame.service = v;
        else frame.method = Number(v);
      } else if (fieldNum === 5) {
        if (wireType !== 2) return null;
        const [len, p2] = readVarint(buf, pos);
        pos = p2;
        frame.headers.push(decodeHeader(buf.subarray(pos, pos + Number(len))));
        pos += Number(len);
      } else if (fieldNum === 8) {
        if (wireType !== 2) return null;
        const [len, p2] = readVarint(buf, pos);
        pos = p2;
        frame.payload = Buffer.from(buf.subarray(pos, pos + Number(len)));
        pos += Number(len);
      } else if (wireType === 0) {
        const [, p2] = readVarint(buf, pos);
        pos = p2;
      } else if (wireType === 1) {
        pos += 8;
      } else if (wireType === 2) {
        const [len, p2] = readVarint(buf, pos);
        pos = p2 + Number(len);
      } else if (wireType === 5) {
        pos += 4;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
  return frame;
}

export function encodeFrame(frame: Frame): Buffer {
  const parts: Buffer[] = [];
  const varintField = (num: number, value: bigint) => {
    parts.push(encodeVarint((BigInt(num) << 3n) | 0n), encodeVarint(value));
  };
  // proto2 required fields — always written, even when zero (mirrors the SDKs).
  varintField(1, frame.seqId);
  varintField(2, frame.logId);
  varintField(3, frame.service);
  varintField(4, BigInt(frame.method));
  for (const header of frame.headers) {
    const keyBuf = Buffer.from(header.key, 'utf-8');
    const valueBuf = Buffer.from(header.value, 'utf-8');
    const entryParts = [
      encodeVarint((1n << 3n) | 2n), encodeVarint(BigInt(keyBuf.length)), keyBuf,
      encodeVarint((2n << 3n) | 2n), encodeVarint(BigInt(valueBuf.length)), valueBuf,
    ];
    const entry = Buffer.concat(entryParts);
    parts.push(encodeVarint((5n << 3n) | 2n), encodeVarint(BigInt(entry.length)), entry);
  }
  if (frame.payload.length > 0) {
    parts.push(encodeVarint((8n << 3n) | 2n), encodeVarint(BigInt(frame.payload.length)), frame.payload);
  }
  return Buffer.concat(parts);
}

function headerValue(headers: FrameHeader[], key: string): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}

interface ClientConfig {
  ReconnectCount?: number;
  ReconnectInterval?: number;
  ReconnectNonce?: number;
  PingInterval?: number;
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
  private _serviceId = 0n;
  private _pingIntervalMs = PING_INTERVAL_MS;
  /** In-flight multi-part messages keyed by message_id (sum/seq reassembly). */
  private _partials = new Map<string, { total: number; parts: Map<number, Buffer> }>();
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
    return `${base}/callback/ws/endpoint`;
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

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Access token request failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '');
      throw new Error(`Access token response returned non-JSON (${contentType}): ${text.slice(0, 200)}`);
    }

    const data = await res.json() as { code: number; msg: string; app_access_token?: string };
    if (data.code !== 0 || !data.app_access_token) {
      throw new Error(`Failed to get access token: ${data.msg || 'unknown error'}`);
    }
    return data.app_access_token;
  }

  private async _getConnectionInfo(): Promise<{ url: string; connection_id: string; service_id: string }> {
    const res = await fetch(this._getWsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'locale': 'zh',
      },
      body: JSON.stringify({ AppID: this._appId, AppSecret: this._appSecret }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WebSocket connection info request failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '');
      throw new Error(`WebSocket connection info returned non-JSON response (${contentType}): ${text.slice(0, 200)}`);
    }

    const data = await res.json() as { code: number; msg: string; data?: { URL?: string; device_id?: string; service_id?: string; ClientConfig?: ClientConfig } };
    if (data.code !== 0 || !data.data?.URL) {
      throw new Error(`Failed to get WebSocket connection info: ${data.msg || 'unknown error'} (code: ${data.code})`);
    }
    if (data.data.ClientConfig?.PingInterval && data.data.ClientConfig.PingInterval > 0) {
      const ms = data.data.ClientConfig.PingInterval;
      this._pingIntervalMs = Math.min(Math.max(ms < 1000 ? ms * 1000 : ms, 5_000), 120_000);
    }
    return {
      url: data.data.URL,
      connection_id: data.data.device_id || '',
      service_id: data.data.service_id || '',
    };
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
        console.warn('[Feishu WS] Application-level ping timed out, reconnecting');
        this._ws?.terminate();
      }, PONG_TIMEOUT_MS);
      // Application-level PING CONTROL frame — required by the protocol
      // (transport-level ws.ping() is NOT what the server watches).
      this._writeFrame({
        seqId: 0n,
        logId: 0n,
        service: this._serviceId,
        method: FRAME_METHOD_CONTROL,
        headers: [{ key: HEADER_TYPE, value: MSG_TYPE_PING }],
        payload: Buffer.alloc(0),
      });
    }, this._pingIntervalMs);
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

  private _writeFrame(frame: Frame): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(encodeFrame(frame));
    }
  }

  /** Acknowledge an EVENT/CARD DATA frame: same frame, payload = {"code":200}. */
  private _ackDataFrame(frame: Frame): void {
    const headers = frame.headers
      .filter((h) => h.key !== HEADER_BIZ_RT)
      .concat([{ key: HEADER_BIZ_RT, value: String(Date.now() % 1_000_000) }]);
    this._writeFrame({
      ...frame,
      headers,
      payload: Buffer.from(JSON.stringify({ code: 200 }), 'utf-8'),
    });
  }

  /** Reassemble multi-part DATA frames (sum/seq), then deliver. */
  private _handleEventData(frame: Frame, msgId: string, sum: number, seq: number): void {
    let payload = frame.payload;
    if (sum > 1) {
      let entry = this._partials.get(msgId);
      if (!entry) {
        entry = { total: sum, parts: new Map() };
        this._partials.set(msgId, entry);
      }
      entry.parts.set(seq, frame.payload);
      if (entry.parts.size < entry.total) return;
      this._partials.delete(msgId);
      payload = Buffer.concat(
        Array.from({ length: entry.total }, (_, i) => entry.parts.get(i) ?? Buffer.alloc(0)),
      );
    }
    try {
      const event = JSON.parse(payload.toString('utf-8'));
      this._onEvent({ type: 'event', data: event });
    } catch (err) {
      console.error('[Feishu WS] Failed to parse event payload:', err instanceof Error ? err.message : String(err));
    }
  }

  private _handleFrame(frame: Frame): void {
    if (frame.method === FRAME_METHOD_CONTROL) {
      const type = headerValue(frame.headers, HEADER_TYPE);
      if (type === MSG_TYPE_PONG) {
        this._handlePong();
      }
      // Server-originated PING needs no reply (mirrors the official SDKs).
      return;
    }

    if (frame.method !== FRAME_METHOD_DATA) return;

    const handshakeStatus = headerValue(frame.headers, HEADER_HANDSHAKE_STATUS);
    if (handshakeStatus !== undefined && handshakeStatus !== '0') {
      const msg = headerValue(frame.headers, HEADER_HANDSHAKE_MSG) ?? 'unknown';
      console.error(`[Feishu WS] Handshake rejected: status=${handshakeStatus} msg=${msg}`);
      this._ws?.close(1000);
      return;
    }

    const type = headerValue(frame.headers, HEADER_TYPE);
    if (type === MSG_TYPE_EVENT) {
      this._ackDataFrame(frame);
      const msgId = headerValue(frame.headers, HEADER_MESSAGE_ID) ?? '';
      const sum = Number(headerValue(frame.headers, HEADER_SUM) ?? '1');
      const seq = Number(headerValue(frame.headers, HEADER_SEQ) ?? '0');
      this._handleEventData(frame, msgId, sum, seq);
    } else if (type === MSG_TYPE_CARD) {
      // Card callbacks are handled via the HTTP webhook path; nothing to do.
    } else {
      console.log(`[Feishu WS] DATA frame ignored: type=${type ?? 'unknown'}`);
    }
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
    const appIdPreview = this._appId ? `${this._appId.slice(0, 8)}...` : 'undefined';
    console.log(`[Feishu WS] Acquiring app lock for ${appIdPreview}...`);
    if (!this._acquireAppLock()) {
      throw new Error(`Failed to acquire app lock for ${this._appId}. Another instance may be running.`);
    }
    console.log(`[Feishu WS] App lock acquired`);

    this._shouldReconnect = true;
    this._running = true;

    try {
      this._lastDisconnectTime = Date.now();
      this._onStatusChange?.('connecting');
      console.log(`[Feishu WS] Getting connection info from ${this._getWsUrl()}...`);

      const { url, connection_id, service_id } = await this._getConnectionInfo();
      this._connectionId = connection_id;
      try {
        const parsed = new URL(url);
        this._serviceId = BigInt(parsed.searchParams.get('service_id') || service_id || '0');
      } catch {
        this._serviceId = 0n;
      }
      console.log(`[Feishu WS] Got connection URL, connecting... (service_id=${this._serviceId})`);

      this._ws = new WebSocket(url);

      this._ws.on('open', () => {
        console.log(`[Feishu WS] WebSocket opened, connectionId: ${this._connectionId.slice(0, 16)}...`);
        this._onStatusChange?.('connected');
        this._startPing();
      });

      this._ws.on('message', (data: WebSocket.Data) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data as Buffer[])
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        const frame = decodeFrame(bytes);
        if (!frame) {
          // Not a valid protobuf frame — log instead of silently swallowing so
          // protocol drift is observable (this hid every event before).
          const preview = bytes.subarray(0, 120).toString('utf-8');
          console.warn(`[Feishu WS] Undecodable frame (${bytes.length} bytes): ${JSON.stringify(preview)}`);
          return;
        }
        this._handleFrame(frame);
      });

      this._ws.on('close', (code: number) => {
        console.log(`[Feishu WS] WebSocket closed with code: ${code}`);
        this._stopPing();
        this._onStatusChange?.('disconnected');
        const isNormal = code === 1000 || code === 1001;
        this._scheduleReconnect(isNormal);
      });

      this._ws.on('error', (err: Error) => {
        console.error(`[Feishu WS] WebSocket error:`, err.message);
      });
    } catch (err) {
      console.error(`[Feishu WS] Connection failed:`, err instanceof Error ? err.message : String(err));
      this._onStatusChange?.('reconnecting');
      this._scheduleReconnect(false);
      throw err;
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
    this._partials.clear();
    this._onStatusChange?.('disconnected');
  }

  send(data: unknown): void {
    // Legacy JSON-text escape hatch kept for API compatibility; the long
    // connection protocol itself has no client-initiated text frames.
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }
}
