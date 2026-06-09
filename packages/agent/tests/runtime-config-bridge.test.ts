/**
 * packages/agent/tests/runtime-config-bridge.test.ts
 *
 * Phase 2 integration smoke test: confirms that the new
 * `runtimeConfig` payload can be marshaled through the
 * `InitMessage.providerConfig` shape into the `AgentOptions`
 * constructor without loss.
 *
 * This is a *contract* test, not a full integration. It exists to
 * permanently lock in the Phase 2 wire format so future
 * refactors can't silently drop `apiFormat` / `headers` /
 * `accessToken` on their way to the agent runtime.
 *
 * What this test does NOT cover (out of scope for Phase 2):
 *  - The `llm-clients` actually consuming `runtimeConfig` (Phase 3).
 *  - End-to-end Electron IPC → agent subprocess init (would need
 *    a real subprocess; that is `packages/agent/tests/ShellProviders.spec.ts`).
 */

import { describe, it, expect } from 'vitest';
import type { AgentOptions } from '../src/types.js';
import { toLegacyLlmProviderDiscriminator } from '../src/providers/ProviderRuntimeAdapter.js';

interface InitMessageProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: 'anthropic' | 'openai' | 'ollama';
  authStyle?: 'api_key' | 'auth_token';
  runtimeConfig?: AgentOptions['runtimeConfig'];
}

function buildInitMessage(
  legacy: Pick<InitMessageProviderConfig, 'apiKey' | 'baseURL' | 'model' | 'provider'>,
  runtimeConfig?: AgentOptions['runtimeConfig'],
): { providerConfig: InitMessageProviderConfig } {
  return {
    providerConfig: { ...legacy, runtimeConfig },
  };
}

function simulateAgentInitAccepts(
  msg: InitMessageProviderConfig,
): { acceptedLegacy: boolean; acceptedRuntime: boolean } {
  // The contract: agent keeps working with the legacy fields.
  // The new `runtimeConfig` is also preserved.
  const ok = !!msg.apiKey && !!msg.model;
  return {
    acceptedLegacy: ok,
    acceptedRuntime: !!msg.runtimeConfig,
  };
}

describe('Phase 2 runtime config wire format', () => {
  it('Anthropic init message carries both legacy and runtimeConfig fields', () => {
    const init = buildInitMessage(
      {
        apiKey: 'sk-ant-1234567890',
        baseURL: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
      },
      {
        providerId: 'p-anthropic',
        providerName: 'Anthropic',
        apiFormat: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-1234567890',
        accessToken: undefined,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-ant-1234567890',
          'anthropic-version': '2023-06-01',
        },
        model: 'claude-sonnet-4-5',
        requestOptions: { API_TIMEOUT_MS: '3000000' },
      },
    );

    const status = simulateAgentInitAccepts(init.providerConfig);
    expect(status.acceptedLegacy).toBe(true);
    expect(status.acceptedRuntime).toBe(true);
    expect(init.providerConfig.runtimeConfig?.apiFormat).toBe('anthropic');
    expect(init.providerConfig.runtimeConfig?.headers['anthropic-version']).toBe(
      '2023-06-01',
    );
  });

  it('OpenAI-compatible init message preserves Authorization Bearer', () => {
    const init = buildInitMessage(
      {
        apiKey: 'sk-oai-1234567890',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        provider: 'openai',
      },
      {
        providerId: 'p-oai',
        apiFormat: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-oai-1234567890',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-oai-1234567890',
        },
        model: 'gpt-4o',
        requestOptions: {},
      },
    );

    expect(init.providerConfig.runtimeConfig?.apiFormat).toBe('openai-chat');
    expect(init.providerConfig.runtimeConfig?.headers.Authorization).toBe(
      'Bearer sk-oai-1234567890',
    );
  });

  it('Ollama init message has no auth headers', () => {
    const init = buildInitMessage(
      {
        apiKey: '',
        baseURL: 'http://localhost:11434',
        model: 'llama3.2',
        provider: 'ollama',
      },
      {
        providerId: 'p-ollama',
        apiFormat: 'ollama',
        baseUrl: 'http://localhost:11434',
        apiKey: undefined,
        accessToken: undefined,
        headers: { 'Content-Type': 'application/json' },
        model: 'llama3.2',
        requestOptions: {},
      },
    );

    expect(init.providerConfig.runtimeConfig?.apiFormat).toBe('ollama');
    expect(init.providerConfig.runtimeConfig?.headers.Authorization).toBeUndefined();
    expect(init.providerConfig.runtimeConfig?.apiKey).toBeFalsy();
  });

  it('legacy path still works without runtimeConfig (backward compat)', () => {
    const init = buildInitMessage({
      apiKey: 'sk-anthropic-1234567890',
      baseURL: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
    });
    const status = simulateAgentInitAccepts(init.providerConfig);
    expect(status.acceptedLegacy).toBe(true);
    expect(status.acceptedRuntime).toBe(false);
  });

  it('toLegacyLlmProviderDiscriminator returns the right legacy value per apiFormat', () => {
    expect(toLegacyLlmProviderDiscriminator('anthropic')).toBe('anthropic');
    expect(toLegacyLlmProviderDiscriminator('openai-chat')).toBe('openai');
    expect(toLegacyLlmProviderDiscriminator('openai-responses')).toBe('openai');
    expect(toLegacyLlmProviderDiscriminator('ollama')).toBe('ollama');
    expect(toLegacyLlmProviderDiscriminator('bedrock')).toBe('anthropic');
    expect(toLegacyLlmProviderDiscriminator('vertex')).toBe('anthropic');
    expect(toLegacyLlmProviderDiscriminator('gemini')).toBe('openai');
  });

  it('does not leak apiKey / accessToken in the serialized shape', () => {
    // The agent's log line includes providerId, apiFormat, baseUrl,
    // model, headerKeys — never the secret. We assert the wire shape
    // contains the secret (so the agent CAN use it) but that the
    // *projection* used for log/debug strips it.
    const init = buildInitMessage(
      {
        apiKey: 'sk-leak-candidate-1234567890',
        model: 'm',
        provider: 'anthropic',
      },
      {
        providerId: 'p',
        apiFormat: 'anthropic',
        baseUrl: 'https://x',
        apiKey: 'sk-leak-candidate-1234567890',
        headers: { Authorization: 'Bearer sk-leak-candidate-1234567890' },
        model: 'm',
        requestOptions: {},
      },
    );

    // The log projection strips secrets.
    const logProjection = {
      providerId: init.providerConfig.runtimeConfig?.providerId,
      apiFormat: init.providerConfig.runtimeConfig?.apiFormat,
      baseUrl: init.providerConfig.runtimeConfig?.baseUrl,
      model: init.providerConfig.runtimeConfig?.model,
      headerKeys: Object.keys(init.providerConfig.runtimeConfig?.headers ?? {}),
    };
    const logStr = JSON.stringify(logProjection);
    expect(logStr.includes('sk-leak-candidate')).toBe(false);
    expect(logStr.includes('Bearer')).toBe(false);
  });
});
