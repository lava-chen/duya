/**
 * Plan 481 amendment — bot-identity:rpc handler tests (profile.set /
 * avatar.set / avatar.clear main-process side).
 *
 * Isolation mirrors electron/config/__tests__/agents.test.ts: a temp
 * ConfigStore per test + the namespace-free duya root. The security
 * binding tests are the core of the suite — a bot may only ever edit its
 * own profile.json.
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

describe('avatar.set / avatar.clear', () => {
  it('writes a valid color token', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'avatar.set',
      payload: { actorAgentId: 'night-ops', avatarColor: 'violet' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(true);
    const profile = profileOf('night-ops');
    expect(profile?.avatarColor).toBe('violet');
  });

  it('installs an image avatar from an absolute path and clears it again', async () => {
    // A real PNG: 1x1 pixel magic header — enough for the sniff check.
    const sourcePath = path.join(dir, 'generated.png');
    fs.writeFileSync(
      sourcePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    );

    const result = await handleBotIdentityRpc({
      subaction: 'avatar.set',
      payload: { actorAgentId: 'night-ops', avatarImagePath: sourcePath, avatarColor: 'blue' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(true);

    const agentDir = path.dirname(getBotProfilePath('night-ops', dir));
    expect(fs.existsSync(path.join(agentDir, 'avatar.png'))).toBe(true);
    const profile = profileOf('night-ops');
    expect(profile?.avatarImage).toBe('avatar.png');
    expect(profile?.avatarColor).toBe('blue');

    const cleared = await handleBotIdentityRpc({
      subaction: 'avatar.clear',
      payload: { actorAgentId: 'night-ops' },
      sessionId: 'bot:night-ops',
    });
    expect(cleared.success).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'avatar.png'))).toBe(false);
    const clearedProfile = profileOf('night-ops');
    expect(clearedProfile?.avatarImage).toBeUndefined();
    expect(clearedProfile?.avatarColor).toBeUndefined();
  });

  it('rejects an image whose content does not match its extension', async () => {
    const sourcePath = path.join(dir, 'fake.png');
    fs.writeFileSync(sourcePath, 'definitely not a png');

    const result = await handleBotIdentityRpc({
      subaction: 'avatar.set',
      payload: { actorAgentId: 'night-ops', avatarImagePath: sourcePath },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WRITE_FAILED');
    expect(result.error?.message).toMatch(/does not match/);
  });

  it('rejects a relative avatarImagePath', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'avatar.set',
      payload: { actorAgentId: 'night-ops', avatarImagePath: 'generated.png' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_AVATAR_IMAGE');
  });

  it('rejects an unknown color token', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'avatar.set',
      payload: { actorAgentId: 'night-ops', avatarColor: 'chartreuse' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_AVATAR_COLOR');
  });

  it('clear removes color and image from profile.json', async () => {
    writeBotProfile(getBotProfilePath('night-ops', dir), {
      name: 'Night Ops',
      title: '',
      description: 'd',
      avatarImage: 'avatar.png',
      avatarColor: 'red',
    });
    const result = await handleBotIdentityRpc({
      subaction: 'avatar.clear',
      payload: { actorAgentId: 'night-ops' },
      sessionId: 'bot:night-ops',
    });
    expect(result.success).toBe(true);
    const profile = profileOf('night-ops');
    expect(profile?.avatarImage).toBeUndefined();
    expect(profile?.avatarColor).toBeUndefined();
    expect(profile?.name).toBe('Night Ops');
  });

  it('rejects avatar.set with no tokens', async () => {
    const result = await handleBotIdentityRpc({
      subaction: 'avatar.set',
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
