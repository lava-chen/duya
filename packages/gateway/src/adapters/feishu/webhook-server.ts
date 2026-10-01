import crypto from 'node:crypto';
import http from 'http';
import type { FeishuEvent } from './types.js';

interface WebhookServerOptions {
  port: number;
  host: string;
  path: string;
  verificationToken?: string;
  encryptKey?: string;
  onEvent: (event: FeishuEvent) => Promise<void>;
  /** Rejection diagnostics. Rejections were previously silent. */
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
}

const RATE_LIMIT_WINDOW_MS = 1000;
const MAX_REQUESTS_PER_WINDOW = 50;
const ANOMALY_THRESHOLD = 1000;
const ANOMALY_WINDOW_MS = 60000;
const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024;

/** How far a request timestamp may drift from now before it is refused. */
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
/** Nonces are remembered for the same window, so a replay inside it is caught. */
const NONCE_TTL_MS = SIGNATURE_MAX_AGE_MS;
/** Bound the replay set so a flood of distinct nonces cannot grow it forever. */
const NONCE_MAX_ENTRIES = 10_000;

/** Read a single request header as a string (Node types it as string | string[]). */
function header(req: http.IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/** Constant-time compare that does not leak length through early return. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing does not depend on the input
    // lengths, then report the mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export class FeishuWebhookServer {
  private _options: WebhookServerOptions;
  private _server: http.Server | null = null;
  private _requestCounts: number[] = [];
  private _anomalyCount = 0;
  private _anomalyWindowStart = 0;
  /** nonce -> expiry, pruned on every insert. */
  private _seenNonces = new Map<string, number>();
  private _onLog: (message: string, detail?: Record<string, unknown>) => void;

  constructor(options: WebhookServerOptions) {
    this._options = options;
    this._onLog = options.onLog ?? (() => {});
    if (!options.verificationToken) {
      // Fail closed, loudly. An unconfigured webhook is not a working
      // webhook: every request below is refused with 503.
      this._onLog('feishu webhook has no verificationToken — all requests will be refused');
    }
  }

  private _checkRateLimit(): boolean {
    const now = Date.now();
    this._requestCounts = this._requestCounts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (this._requestCounts.length >= MAX_REQUESTS_PER_WINDOW) {
      return false;
    }
    this._requestCounts.push(now);
    return true;
  }

  private _trackAnomaly(): boolean {
    const now = Date.now();
    if (now - this._anomalyWindowStart > ANOMALY_WINDOW_MS) {
      this._anomalyCount = 0;
      this._anomalyWindowStart = now;
    }
    this._anomalyCount++;
    if (this._anomalyCount > ANOMALY_THRESHOLD) {
      return false;
    }
    return true;
  }

  /**
   * True the first time this nonce is seen, false on a replay. Expiry is
   * bounded by NONCE_TTL_MS, which is also the freshness window, so a
   * captured request cannot be replayed for longer than its signature
   * would otherwise remain acceptable.
   */
  private _consumeNonce(nonce: string, now: number): boolean {
    for (const [key, expiry] of this._seenNonces) {
      if (expiry <= now) this._seenNonces.delete(key);
    }
    if (this._seenNonces.has(nonce)) return false;
    if (this._seenNonces.size >= NONCE_MAX_ENTRIES) {
      // Bounded set: drop the entry closest to expiry rather than refuse
      // service. The signature window still limits what a replay can do.
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, expiry] of this._seenNonces) {
        if (expiry < oldest) { oldest = expiry; oldestKey = key; }
      }
      if (oldestKey !== null) this._seenNonces.delete(oldestKey);
    }
    this._seenNonces.set(nonce, now + NONCE_TTL_MS);
    return true;
  }

  /**
   * Verify the `X-Lark-Signature` header when an encryptKey is configured.
   *
   * Algorithm, per the official spec (see the URL at the call site):
   *   content   = timestamp + nonce + encrypt_key + body, unseparated
   *   signature = sha256(content) as lowercase hex
   *
   * The body is the raw request body, not a re-serialised object: the
   * re-serialisation would change key order and whitespace, and therefore
   * the digest.
   *
   * Do NOT "fix" this to match `@larksuiteoapi/node-sdk`. Its
   * `RequestHandle` signs `sha256(timestamp + nonce + encryptKey +
   * JSON.stringify(data))` over the *parsed* body object, which by then
   * also carries `headers`, so it does not reproduce what a server signs
   * and is not a usable reference implementation. The spec above is the
   * authority.
   *
   * This only runs when `encryptKey` is set. With no key configured the
   * check is skipped, so setups that never configured one are unaffected.
   */
  private _verifySignature(
    req: http.IncomingMessage,
    rawBody: string,
    now: number,
  ): { ok: true } | { ok: false; reason: string } {
    const encryptKey = this._options.encryptKey;
    if (!encryptKey) return { ok: true };

    const signature = header(req, 'x-lark-signature');
    const timestamp = header(req, 'x-lark-request-timestamp');
    const nonce = header(req, 'x-lark-request-nonce');

    if (!signature || !timestamp || !nonce) {
      return { ok: false, reason: 'missing signature headers' };
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return { ok: false, reason: 'unparsable timestamp' };
    }
    // Feishu sends seconds; tolerate milliseconds from a misconfigured proxy.
    const tsMs = ts > 1e12 ? ts : ts * 1000;
    if (Math.abs(now - tsMs) > SIGNATURE_MAX_AGE_MS) {
      return { ok: false, reason: 'stale timestamp' };
    }
    if (!this._consumeNonce(nonce, now)) {
      return { ok: false, reason: 'replayed nonce' };
    }

    // Signature, exactly as the official spec defines it:
    //   content   = timestamp + nonce + encrypt_key + body   (no separators)
    //   signature = sha256(content).hexdigest()
    // The concatenation is unseparated in all six reference implementations
    // (Python / Java / Golang / Node.js / C# / PHP). See
    // https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case
    const expected = crypto
      .createHash('sha256')
      .update(timestamp + nonce + encryptKey + rawBody)
      .digest('hex');
    if (!timingSafeEqualStr(expected, signature)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    return { ok: true };
  }

  private _verifyChallenge(body: FeishuEvent): { challenge: string } | null {
    if (body.type === 'url_verification') {
      const token = body.token || '';
      const challenge = body.challenge || '';
      if (this._options.verificationToken && token !== this._options.verificationToken) {
        return null;
      }
      return { challenge };
    }
    return null;
  }

  /**
   * Deliver an already-verified, already-authenticated event to the adapter.
   *
   * This runs after the 200 ack, so anything it throws can no longer be
   * turned into an HTTP error response. It is caught and logged here on
   * purpose: the request handler's own `catch` is guarded by
   * `!res.headersSent`, so once the ack is out that guard is false and an
   * `onEvent` rejection was dropped on the floor — a webhook that answers
   * 200 and silently does nothing, with no trace of why.
   */
  private async _dispatch(event: FeishuEvent): Promise<void> {
    try {
      await this._options.onEvent(event);
    } catch (err) {
      this._onLog('feishu webhook onEvent threw after ack', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server = http.createServer(async (req, res) => {
        // The configured path is the only endpoint. Without this check any
        // path on the port was accepted, so the URL carried no meaning.
        const requestPath = (req.url ?? '').split('?')[0];
        if (requestPath !== this._options.path) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!this._checkRateLimit()) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many requests' }));
          return;
        }

        if (!this._trackAnomaly()) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
          return;
        }

        // Fail closed: without a token there is nothing to verify against,
        // so accepting would mean accepting anything.
        const expectedToken = this._options.verificationToken;
        if (!expectedToken) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Webhook not configured: verificationToken missing' }));
          return;
        }

        const bodyChunks: Buffer[] = [];
        let bodySize = 0;

        req.on('data', (chunk: Buffer) => {
          bodySize += chunk.length;
          if (bodySize > MAX_PAYLOAD_SIZE) {
            req.destroy();
            return;
          }
          bodyChunks.push(chunk);
        });

        req.on('end', async () => {
          try {
            const rawBody = Buffer.concat(bodyChunks).toString('utf-8');

            // Signature first: it covers the raw body, so it cannot be
            // checked after the body has been re-serialised.
            const sig = this._verifySignature(req, rawBody, Date.now());
            if (!sig.ok) {
              this._onLog(`feishu webhook rejected: ${sig.reason}`, {
                path: requestPath,
              });
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unauthorized' }));
              return;
            }

            // Mandatory token check. The previous form was
            //   if (headerToken && headerToken !== token) -> 401
            // which a caller bypasses by simply omitting the header.
            const headerToken = header(req, 'x-lark-request-token');
            if (!timingSafeEqualStr(headerToken, expectedToken)) {
              this._onLog('feishu webhook rejected: bad or missing request token', {
                path: requestPath,
                tokenPresent: headerToken.length > 0,
              });
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unauthorized' }));
              return;
            }

            const body = JSON.parse(rawBody) as FeishuEvent;

            const challenge = this._verifyChallenge(body);
            if (challenge) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(challenge));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0 }));

            await this._dispatch(body);
          } catch (err) {
            this._onLog('feishu webhook request failed', {
              path: requestPath,
              error: err instanceof Error ? err.message : String(err),
            });
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal server error' }));
            }
          }
        });
      });

      this._server.on('error', (err) => {
        reject(err);
      });

      this._server.listen(this._options.port, this._options.host, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => {
          this._server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}