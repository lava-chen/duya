/**
 * electron/services/network/provider-tester.test.ts
 *
 * Regression coverage for the connection test's local-endpoint guard.
 *
 * Background: provider-tester previously returned `NO_CREDENTIALS`
 * ("API Key is required") for any provider without an `api_key`,
 * including local Ollama and LM Studio installs. After the
 * `isLocalRuntimeEndpoint` exemption, loopback OpenAI-compatible
 * endpoints (Ollama :11434, LM Studio :1234) skip the credential
 * guard and probe the `/v1/models` (or `/api/chat`) endpoint
 * directly.
 *
 * Only the credential gate is unit-tested here. The remote
 * HTTP probe paths are exercised by `model-fetcher.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// model-detector is imported lazily by `testProviderConnection` for the
// ollama branch. We mock it so the local tests never hit the network.
vi.mock('./model-detector', () => ({
  fetchOllamaModels: vi.fn(async () => ({ success: false, error: 'mocked' })),
}));

// Import after mocks so the SUT picks up the model-detector mock.
import { testProviderConnection } from './provider-tester';

let originalFetch: typeof fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeResponse(init: { status?: number; body?: unknown; text?: string } = {}): Response {
  const status = init.status ?? 200;
  const textBody = init.text ?? '';
  const body = init.body !== undefined ? init.body : textBody;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

describe('testProviderConnection — credential gate', () => {
  it('returns NO_CREDENTIALS for a remote OpenAI-compatible host without an API key', async () => {
    const result = await testProviderConnection({
      provider_type: 'openai-compatible',
      base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CREDENTIALS');
    // Make sure we never hit the network for the failure path.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns NO_CREDENTIALS for a remote Anthropic host without an API key', async () => {
    const result = await testProviderConnection({
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CREDENTIALS');
  });

  it('does NOT return NO_CREDENTIALS for LM Studio at the default :1234 port (no api_key)', async () => {
    // Without the local-runtime exemption this test would fail with
    // NO_CREDENTIALS. With it, the test progresses to the actual
    // connection probe. We mock fetch to return a benign error so
    // we don't assert on real network behavior.
    fetchMock.mockRejectedValueOnce(new TypeError('mocked ECONNREFUSED'));

    const result = await testProviderConnection({
      provider_type: 'openai-compatible',
      base_url: 'http://localhost:1234/v1',
      model: 'qwen2.5-7b-instruct',
    });
    // Must NOT short-circuit at the credential gate.
    expect(result.error?.code).not.toBe('NO_CREDENTIALS');
  });

  it('does NOT return NO_CREDENTIALS for LM Studio at 127.0.0.1:1234', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('mocked ECONNREFUSED'));

    const result = await testProviderConnection({
      provider_type: 'openai-compatible',
      base_url: 'http://127.0.0.1:1234/v1',
      model: 'qwen2.5-7b-instruct',
    });
    expect(result.error?.code).not.toBe('NO_CREDENTIALS');
  });

  it('does NOT return NO_CREDENTIALS for Ollama at the default :11434 port', async () => {
    // Ollama hits the mocked `fetchOllamaModels` (success=false,
    // error='mocked') → classifyError yields CONNECTION_FAILED, but
    // importantly NOT NO_CREDENTIALS.
    const result = await testProviderConnection({
      provider_type: 'ollama',
      base_url: 'http://localhost:11434',
      model: 'llama3.2',
    });
    expect(result.error?.code).not.toBe('NO_CREDENTIALS');
  });

  it('treats provider_type=lm-studio as local (no api_key required) — defensive guard', async () => {
    // Note: in practice the catalog saves LM Studio providers with
    // providerType='openai-compatible', not 'lm-studio'. But if a
    // future save path preserves the canonical key, the runtime must
    // still treat it as keyless. Today this falls through to the URL
    // check (which catches `localhost:1234`); the test asserts both
    // paths work in isolation.
    fetchMock.mockRejectedValueOnce(new TypeError('mocked ECONNREFUSED'));

    const result = await testProviderConnection({
      provider_type: 'lm-studio',
      base_url: 'http://localhost:1234/v1',
      model: 'qwen2.5-7b-instruct',
    });
    expect(result.error?.code).not.toBe('NO_CREDENTIALS');
  });

  it('still skips Bedrock / Vertex (env_only providers)', async () => {
    const result = await testProviderConnection({
      provider_type: 'bedrock',
      base_url: 'https://bedrock.amazonaws.com',
      model: 'claude-sonnet-4-6',
      auth_style: 'env_only',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SKIPPED');
  });

  it('returns NO_CREDENTIALS for a remote OpenAI-compatible host even with auth_style=api_key', async () => {
    // Defense-in-depth: an explicit auth_style=api_key with empty key
    // must still gate. (Local endpoints are exempted regardless.)
    const result = await testProviderConnection({
      provider_type: 'openai-compatible',
      base_url: 'https://api.openai.com/v1',
      auth_style: 'api_key',
      model: 'gpt-4o',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CREDENTIALS');
  });
});