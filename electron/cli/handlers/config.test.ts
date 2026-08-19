/**
 * electron/cli/handlers/config.test.ts
 *
 * Handler tests for the `duya config settings-set` field mapping
 * (Plan 102). The config store is a real ConfigStore over a temp
 * config.toml so `set` behaves like production; the provider store /
 * pairing store / agents module are mocked.
 *
 * Regression guard: legacy camelCase wire fields must land on the
 * canonical config.toml keys — the default model at `model.default`
 * (NOT `agent.model`) and agent knobs in snake_case (`agent.max_tokens`),
 * mirroring `electron/config/migrate.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.env.DUYA_CLI_USER_DATA_DIR ?? tmpdir(),
  },
}));

const mocks = vi.hoisted(() => ({
  providers: {
    listLlmProviders: vi.fn(() => []),
    getLlmProvider: vi.fn(() => undefined),
    upsertLlmProvider: vi.fn(() => ({ ok: true })),
    deleteLlmProvider: vi.fn(() => true),
    setDefaultLlmProvider: vi.fn(() => true),
  },
  pairing: {
    listAllPending: vi.fn(() => []),
    listApproved: vi.fn(() => []),
    approve: vi.fn(() => ({ approved: false })),
    revoke: vi.fn(() => false),
    isApproved: vi.fn(() => false),
  },
  agents: {
    listConfigAgents: vi.fn(() => []),
    upsertConfigAgent: vi.fn(),
    deleteConfigAgent: vi.fn(() => true),
  },
}));

vi.mock('../../services/providers/provider-store-electron', () => ({
  getProviderStore: () => mocks.providers,
}));

vi.mock('../../gateway/pairing', () => ({
  getPairingStore: () => mocks.pairing,
}));

vi.mock('../../config/agents', () => ({
  listConfigAgents: () => mocks.agents.listConfigAgents(),
  upsertConfigAgent: () => mocks.agents.upsertConfigAgent(),
  deleteConfigAgent: () => mocks.agents.deleteConfigAgent(),
}));

import { _setConfigStoreForTest, getConfigStore } from '../../config/store-instance';
import { ConfigStore } from '../../config/store';
import { handleSetAgentSettings } from './config.js';

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeRes(): { res: ServerResponse; capture: CapturedResponse } {
  const capture: CapturedResponse = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      capture.status = status;
    },
    end(payload?: string | unknown) {
      if (typeof payload === 'string') {
        try {
          capture.body = JSON.parse(payload);
        } catch {
          capture.body = payload;
        }
      } else {
        capture.body = payload;
      }
    },
  } as unknown as ServerResponse;
  return { res, capture };
}

function makeReq(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { headers: {} }) as unknown as IncomingMessage;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-config-handler-'));
  process.env.DUYA_CLI_USER_DATA_DIR = tmpDir;
  const store = new ConfigStore({
    configPath: join(tmpDir, 'config.toml'),
    secretsPath: join(tmpDir, 'secrets.json'),
  });
  _setConfigStoreForTest(store);
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  delete process.env.DUYA_CLI_USER_DATA_DIR;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('handleSetAgentSettings — field mapping', () => {
  it('maps --model to model.default, not agent.model', async () => {
    const { res, capture } = makeRes();
    await handleSetAgentSettings(makeReq({ model: 'claude-x' }), res);

    expect(capture.status).toBe(200);
    expect(getConfigStore().getByPath('model.default')).toBe('claude-x');
    // The default model must NOT live under the agent block.
    expect((getConfigStore().getByPath('agent') as Record<string, unknown>).model).toBeUndefined();
  });

  it('maps maxTokens to agent.max_tokens (snake_case) and temperature to agent.temperature', async () => {
    const { res, capture } = makeRes();
    await handleSetAgentSettings(makeReq({ maxTokens: 4096, temperature: 0.2 }), res);

    expect(capture.status).toBe(200);
    const agent = getConfigStore().getByPath('agent') as Record<string, unknown>;
    expect(agent.max_tokens).toBe(4096);
    expect(agent.maxTokens).toBeUndefined();
    expect(agent.temperature).toBe(0.2);
  });

  it('rejects an empty patch with 400', async () => {
    const { res, capture } = makeRes();
    await handleSetAgentSettings(makeReq({}), res);
    expect(capture.status).toBe(400);
  });
});