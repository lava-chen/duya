/**
 * packages/ai/test/api/bedrock-sigv4-webcrypto.test.ts
 *
 * Plan 610 §3.1 — the Bedrock signer moved from `node:crypto` to WebCrypto so
 * the `@duya/ai` barrel stays inside a browser renderer's import closure (gate
 * G10). That change swapped the HMAC implementation, and the pre-existing
 * signing tests could not have caught a wrong one: they assert the
 * Authorization header's SHAPE, and `bedrock-converse.test.ts:36` compares
 * `x-amz-content-sha256` against itself. Ten shape assertions stay green under
 * a completely wrong signature.
 *
 * So these are known-answer vectors instead. The expected strings were produced
 * by the PRE-CHANGE implementation — `git show
 * HEAD:packages/ai/src/api/bedrock-converse.ts`, with only its lazy
 * `require('node:crypto')` rewritten to a static import so it could be loaded
 * side by side — and the two were compared on identical inputs. Every constant
 * below is therefore a value from a DIFFERENT implementation than the one
 * under test, which is the only kind of comparison that can fail here.
 */

import { describe, it, expect } from 'vitest';
import { signBedrockRequest } from '../../src/api/bedrock-converse.js';

const FIXED_NOW = new Date(Date.UTC(2026, 0, 5, 10, 30, 0));

interface Vector {
  readonly label: string;
  readonly params: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
    method: string;
    host: string;
    path: string;
    body: string;
    now: Date;
  };
  readonly authorization: string;
  readonly payloadHash: string;
}

const VECTORS: readonly Vector[] = [
  {
    label: 'the shape the docs example uses',
    params: {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      method: 'POST',
      host: 'bedrock-runtime.us-east-1.amazonaws.com',
      path: '/model/anthropic.claude-sonnet-4-20250514-v1:0/converse-stream',
      body: '{"messages":[]}',
      now: FIXED_NOW,
    },
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260105/us-east-1/bedrock/aws4_request, ' +
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=eb72498dcd00d9b1d9be577eb64484a04e87d6ddb804e6a0a922359e6abcffc1',
    payloadHash: '5e4ce7b36ba37b78a5d5f9fd08e6b7b54ba6879d651aa46ec9e1d6fa24ebe30a',
  },
  {
    label: 'a session token adds a signed header',
    params: {
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      sessionToken: 'TOKEN-XYZ',
      region: 'eu-west-1',
      method: 'POST',
      host: 'h',
      path: '/p',
      body: 'first',
      now: FIXED_NOW,
    },
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKID/20260105/eu-west-1/bedrock/aws4_request, ' +
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, ' +
      'Signature=17f445806540d155fa7ace26558b28c556252e5d818ac1ef22a74c2b33343910',
    payloadHash: 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e',
  },
  {
    // The body is not ASCII, so this vector is the one that pins the encoder.
    // `createHash().update(string)` defaults to utf8; a WebCrypto
    // implementation that encoded it differently would digest different bytes
    // and land on a different signature.
    label: 'a non-ASCII body and a secret with SigV4-special characters',
    params: {
      accessKeyId: 'AKID2',
      secretAccessKey: 'SECRET/KEY+WITH=CHARS',
      region: 'ap-southeast-1',
      method: 'POST',
      host: 'bedrock-runtime.ap-southeast-1.amazonaws.com',
      path: '/model/m/converse-stream',
      body: '{"t":"中文 é 🚀"}',
      now: new Date(Date.UTC(2025, 11, 31, 23, 59, 59)),
    },
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKID2/20251231/ap-southeast-1/bedrock/aws4_request, ' +
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=3992a8e82f0da16dd709a034aa2f63932692c1f07faf3ad5e06b4fc6c61cf5a4',
    payloadHash: '27edf8382f85d3b6e7bdc91ef60d0a2136f5871fc3cddfabeef494c0c2900976',
  },
];

describe('SigV4 known-answer vectors (WebCrypto signing)', () => {
  for (const vector of VECTORS) {
    it(`reproduces the node:crypto signature for ${vector.label}`, async () => {
      const headers = await signBedrockRequest(vector.params);
      expect(headers.Authorization).toBe(vector.authorization);
      expect(headers['x-amz-content-sha256']).toBe(vector.payloadHash);
    });
  }

  it('signs without importing a Node built-in', async () => {
    // The property that motivated the change, asserted directly instead of
    // being left to gate G10: the signer reaches its primitives through the
    // ambient WebCrypto handle, so there is no specifier for a browser bundler
    // to externalize. A regression to `node:crypto` fails here.
    const { default: fs } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'src',
        'api',
        'bedrock-converse.ts',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]node:crypto['"]/);
    expect(source).not.toMatch(/require\(\s*['"]node:crypto['"]\s*\)/);
  });
});
