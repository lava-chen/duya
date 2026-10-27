/**
 * Shared HTTP listener for webhook-based channels.
 *
 * WhatsApp Cloud, Microsoft Graph, the generic webhook channel and BlueBubbles
 * all need the same plumbing and all get it wrong in the same way when written
 * separately: body limits applied after buffering, signature checks after JSON
 * parsing, sockets left half-open on shutdown, and bind failures that surface as
 * an unhandled `EADDRINUSE`.
 *
 * `WebhookServer` owns the transport; subclasses own the protocol.
 */

import http from 'node:http';

export interface WebhookRequest {
  method: string;
  /** Request path without query string. */
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  /** Raw bytes — signature verification must run over these, never over JSON. */
  rawBody: Buffer;
  remoteAddress: string;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  contentType?: string;
}

export interface WebhookServerOptions {
  port: number;
  /** Defaults to loopback: vendor callbacks require a public tunnel anyway. */
  host?: string;
  /** Exact paths handled by `onRequest`. */
  paths: string[];
  /** When true, `paths` are treated as prefixes (e.g. `/webhooks`). */
  pathPrefix?: boolean;
  /** Body cap in bytes; defaults to 1 MiB. */
  maxBodyBytes?: number;
  /** Path answering `200 ok` for liveness probes. Defaults to `/health`. */
  healthPath?: string;
  onRequest: (req: WebhookRequest) => Promise<WebhookResponse>;
  onError?: (err: unknown) => void;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class WebhookServer {
  private readonly options: WebhookServerOptions;
  private server: http.Server | null = null;
  private boundPort = 0;
  private boundHost = '';

  constructor(options: WebhookServerOptions) {
    this.options = options;
  }

  get isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Effective port (useful when `port: 0` was requested in tests). */
  get port(): number {
    return this.boundPort;
  }

  get host(): string {
    return this.boundHost;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const host = this.options.host ?? '127.0.0.1';
    const maxBody = Math.max(1024, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);

    const server = http.createServer((req, res) => {
      void this.handle(req, res, maxBody);
    });

    this.server = server;
    this.boundHost = host;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        this.server = null;
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Webhook port ${this.options.port} is already in use`));
          return;
        }
        if (err.code === 'EACCES') {
          reject(new Error(`Not allowed to bind webhook port ${this.options.port}`));
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        this.boundPort = typeof address === 'object' && address ? address.port : this.options.port;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.port, host);
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    // Sockets held open by a vendor retry would otherwise delay shutdown until
    // the gateway's stop timeout fires.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.boundPort = 0;
  }

  private pathMatches(path: string): boolean {
    if (path === (this.options.healthPath ?? '/health')) return true;
    if (this.options.pathPrefix) {
      return this.options.paths.some((p) => path === p || path.startsWith(`${p}/`));
    }
    return this.options.paths.includes(path);
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    maxBodyBytes: number,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (!this.pathMatches(path)) {
      this.send(res, { status: 404, body: 'not found', contentType: 'text/plain' });
      return;
    }

    if (path === (this.options.healthPath ?? '/health') && (req.method === 'GET' || req.method === 'HEAD')) {
      this.send(res, { status: 200, body: 'ok', contentType: 'text/plain' });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBody(req, maxBodyBytes);
    } catch (err) {
      const tooLarge = err instanceof BodyTooLargeError;
      this.send(res, {
        status: tooLarge ? 413 : 400,
        body: tooLarge ? 'payload too large' : 'unreadable body',
        contentType: 'text/plain',
      });
      return;
    }

    try {
      const response = await this.options.onRequest({
        method: req.method ?? 'GET',
        path,
        query: url.searchParams,
        headers: req.headers,
        rawBody,
        remoteAddress: req.socket.remoteAddress ?? '',
      });
      this.send(res, response);
    } catch (err) {
      this.options.onError?.(err);
      this.send(res, { status: 500, body: 'internal error', contentType: 'text/plain' });
    }
  }

  private send(res: http.ServerResponse, response: WebhookResponse): void {
    if (res.writableEnded) return;
    const body = response.body ?? '';
    res.writeHead(response.status, {
      'Content-Type': response.contentType ?? 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

class BodyTooLargeError extends Error {}

function readBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      // Reject before buffering: an oversized body must not cost the memory.
      req.resume();
      reject(new BodyTooLargeError());
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** First value of a possibly-repeated header. */
export function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
