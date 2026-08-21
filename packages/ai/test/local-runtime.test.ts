/**
 * packages/ai/test/local-runtime.test.ts
 *
 * Unit tests for the local-runtime OpenAI SDK shim. The official OpenAI
 * Node SDK refuses to instantiate without an `apiKey` constructor
 * argument OR the `OPENAI_API_KEY` env var set:
 *
 *   `Missing credentials. Please pass an 'apiKey', 'workloadIdentity',
 *    'adminAPIKey', or set the 'OPENAI_API_KEY' or 'OPENAI_ADMIN_KEY'
 *    environment variable.`
 *
 * For LM Studio / Ollama installs neither is present. We inject a
 * stable placeholder at the SDK boundary so the client constructs.
 * The placeholder is forwarded as `Authorization: Bearer lm-studio-local`
 * but LM Studio ignores it, so this is safe.
 *
 * Mirrors openclaw's `LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER = 'lmstudio-local'`
 * convention from `extensions/lmstudio/src/api.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  LM_STUDIO_PLACEHOLDER_KEY,
  localRuntimeApiKeyOrPlaceholder,
} from '../src/api/local-runtime.js';

describe('LM_STUDIO_PLACEHOLDER_KEY', () => {
  it('matches the openclaw convention ("lmstudio-local")', () => {
    // The exact string matters because some logs and gateway payloads
    // compare against it. Changing the value requires updating any
    // cross-package comparator at the same time.
    expect(LM_STUDIO_PLACEHOLDER_KEY).toBe('lmstudio-local');
  });
});

describe('localRuntimeApiKeyOrPlaceholder', () => {
  it('returns the placeholder when apiKey is undefined', () => {
    expect(localRuntimeApiKeyOrPlaceholder(undefined)).toBe(
      LM_STUDIO_PLACEHOLDER_KEY,
    );
  });

  it('returns the placeholder when apiKey is null', () => {
    expect(localRuntimeApiKeyOrPlaceholder(null)).toBe(
      LM_STUDIO_PLACEHOLDER_KEY,
    );
  });

  it('returns the placeholder when apiKey is empty string', () => {
    expect(localRuntimeApiKeyOrPlaceholder('')).toBe(
      LM_STUDIO_PLACEHOLDER_KEY,
    );
  });

  it('returns the user-supplied apiKey when it is a non-empty string', () => {
    // Preserves real keys untouched \u2014 the placeholder is only for
    // the empty / missing case. Remote providers with explicit keys
    // must NOT receive the placeholder.
    expect(localRuntimeApiKeyOrPlaceholder('sk-real-key')).toBe(
      'sk-real-key',
    );
  });

  it('returns the placeholder for whitespace-only apiKey', () => {
    // Defensive: a whitespace-only key would still fail the SDK's
    // non-empty check downstream. Treat it as missing so the
    // placeholder flows through.
    expect(localRuntimeApiKeyOrPlaceholder('   ')).toBe(
      LM_STUDIO_PLACEHOLDER_KEY,
    );
  });
});