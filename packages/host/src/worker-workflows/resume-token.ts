/** Native HMAC adapter for the pure resume-token contract. */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { ResumeTokenPayload, ResumeTokenPort } from '@duya/workflow';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createResumeTokenPort(secret: string): ResumeTokenPort {
  return {
    create(payload) {
      const full: ResumeTokenPayload = { ...payload, nonce: payload.nonce ?? randomUUID() };
      const body = b64url(JSON.stringify(full));
      const signature = createHmac('sha256', secret).update(body).digest('base64url');
      return `${body}.${signature}`;
    },
    verify(token) {
      const dot = token.lastIndexOf('.');
      if (dot <= 0) return null;
      const body = token.slice(0, dot);
      const signature = token.slice(dot + 1);
      const expected = createHmac('sha256', secret).update(body).digest('base64url');
      const left = Buffer.from(signature);
      const right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ResumeTokenPayload;
        if (typeof payload.runId !== 'string' || typeof payload.nodeId !== 'string' ||
          typeof payload.issuedAt !== 'number' || typeof payload.nonce !== 'string') return null;
        return payload;
      } catch {
        return null;
      }
    },
  };
}

export function createResumeToken(
  secret: string,
  payload: Omit<ResumeTokenPayload, 'nonce'> & { nonce?: string },
): string {
  return createResumeTokenPort(secret).create(payload);
}

export function verifyResumeToken(secret: string, token: string): ResumeTokenPayload | null {
  return createResumeTokenPort(secret).verify(token);
}

export type { ResumeTokenPayload } from '@duya/workflow';
