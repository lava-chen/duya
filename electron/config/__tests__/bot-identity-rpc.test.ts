/**
 * Plan 481 amendment — bot-identity:rpc handler tests (profile.set,
 * main-process side).
 *
 * Isolation mirrors electron/config/__tests__/agents.test.ts: a temp
 * ConfigStore per test + the namespace-free duya root. The security
 * binding tests are the core of the suite — a bot may only ever edit its
 * own profile.json. (The avatar image upload path was removed: the avatar
 * is the animated agent face, and only its color token is configurable.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: { AgentProcess: 'AgentProcess', AgentCommunicator: 'AgentCommunicator' },
}));

import { ConfigStore } from '../store';
import { _setConfigStoreForTest } from '../store-instance';
import { handleBotIdentityRpc } from '../bot-identity-rpc';
import { upsertConfigAgent } from '../agents';
import { readBotProfile, writeBotProfile } from '../bot-profile';
import { getBotProfilePath } from '../agent-paths';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bot-identity-rpc-'));
}

let dir: string;

beforeEach(() => {
  dir = tmpDir();
  const store = new ConfigStore({
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  });
  _setConfigStoreForTest(store);
  upsertConfigAgent('night-ops', { name: 'Night Ops', description: 'bot under test' });
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function profileOf(id: string) {
  return readBotProfile(getBotProfilePath(id, dir));
}

describe('security binding (session bot:<id> === actor)', () => {
  it('rejects a plain (non-bot) session outright', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'night-ops', name: 'X' },
      sessionId: 'session-abc',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_IDENTITY');
  });

  it('rejects an actor that does not match the session binding', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'imposter', name: 'X' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('IDENTITY_MISMATCH');
  });

  it('rejects a missing sessionId', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'night-ops', name: 'X' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_IDENTITY');
  });
});

describe('profile.set', () => {
  it('writes name and description into profile.json and preserves title', async () => {
    // Seed a profile with a host-managed title.
    writeBotProfile(getBotProfilePath('night-ops', dir), {
      name: 'Night Ops',
      title: 'The Night Shift',
      description: 'old',
    });

    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'night-ops', name: 'Night Owl', description: 'new role' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(true);

    const profile = profileOf('night-ops');
    expect(profile?.name).toBe('Night Owl');
    expect(profile?.description).toBe('new role');
    // Title is host-managed (485 §2.4) — untouched by the model write.
    expect(profile?.title).toBe('The Night Shift');
  });

  it('seeds a legacy config-only agent (no profile yet)', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'night-ops', description: 'born from config' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(true);
    const profile = profileOf('night-ops');
    expect(profile?.name).toBe('Night Ops'); // falls back to config seed
    expect(profile?.description).toBe('born from config');
  });

  it('writes a valid avatar color token', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'night-ops', avatarColor: 'violet' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(true);
    const profile = profileOf('night-ops');
    expect(profile?.avatarColor).toBe('violet');
  });

  it('rejects an unknown avatar color token', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'night-ops', avatarColor: 'chartreuse' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_AVATAR_COLOR');
  });

  it('rejects an empty patch', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'night-ops' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PAYLOAD');
  });
});

describe('envelope validation', () => {
  it('rejects an unknown subaction', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'settings.set',
      payload: { actorAgentId: 'night-ops' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('rejects the removed avatar subactions', async () => {
    for (const subaction of ['avatar.set', 'avatar.clear']) {
      const result = await handleBotIdentityRpc({
        subaction,
        payload: { actorAgentId: 'night-ops' },
        sessionId: 'bot:night-ops',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_ACTION');
    }
  });

  it('rejects an actor that does not exist in config', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'profile.set',
      payload: { actorAgentId: 'ghost', name: 'X' },
      sessionId: 'bot:ghost',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WRITE_FAILED');
  });
});
