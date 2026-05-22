﻿import http from 'http';
import type { FeishuEvent } from './types';

interface WebhookServerOptions {
  port: number;
  host: string;
  path: string;
  verificationToken?: string;
  encryptKey?: string;
  onEvent: (event: FeishuEvent) => Promise<void>;
}

const RATE_LIMIT_WINDOW_MS = 1000;
const MAX_REQUESTS_PER_WINDOW = 50;
const ANOMALY_THRESHOLD = 1000;
const ANOMALY_WINDOW_MS = 60000;
const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024;

export class FeishuWebhookServer {
  private _options: WebhookServerOptions;
  private _server: http.Server | null = null;
  private _requestCounts: number[] = [];
  private _anomalyCount = 0;
  private _anomalyWindowStart = 0;

  constructor(options: WebhookServerOptions) {
    this._options = options;
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

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server = http.createServer(async (req, res) => {
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
            const body = JSON.parse(rawBody) as FeishuEvent;

            const challenge = this._verifyChallenge(body);
            if (challenge) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(challenge));
              return;
            }

            if (this._options.verificationToken) {
              const headerToken = req.headers['x-lark-request-token'] || '';
              if (headerToken && headerToken !== this._options.verificationToken) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0 }));

            await this._options.onEvent(body);
          } catch {
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