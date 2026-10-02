/**
 * legacy-root-migration.test.ts — plan 526 one-way merge from the legacy
 * `<userData>/agents` tree into the shared agents root.
 *
 * The shared root comes from the ConfigStore singleton (temp store injected);
 * the legacy root comes from the mocked electron `app.getPath('userData')`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => mocks.userDataDir,
  },
}));

import { ConfigStore } from '../../config/store';
import { _setConfigStoreForTest } from '../../config/store-instance';
import { migrateLegacyAgentChannelData } from '../legacy-root-migration';

let tmpRoot: string;
let legacyAgents: string;
let sharedAgents: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-legacy-migration-'));
  mocks.userDataDir = tmpRoot;
  legacyAgents = path.join(tmpRoot, 'agents');
  sharedAgents = path.join(tmpRoot, 'shared-root', 'agents');
  fs.mkdirSync(legacyAgents, { recursive: true });
  _setConfigStoreForTest(
    new ConfigStore({
      configPath: path.join(tmpRoot, 'shared-root', 'config.toml'),
      secretsPath: path.join(tmpRoot, 'shared-root', 'secrets.json'),
    }),
  );
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Fixture writer: containment-checked against the legacy agents root. */
function writeLegacy(rel: string, content = 'x'): void {
  const root = path.resolve(legacyAgents);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) {
    throw new Error(`fixture path escapes legacy root: ${rel}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('migrateLegacyAgentChannelData', () => {
  it('copies channels, secrets, gateway and attachments into the shared root', () => {
    writeLegacy('bot-a/channels/telegram/connection.json', '{"label":"tg"}');
    writeLegacy('bot-a/connector-secrets/telegram.json', '{"token":"t"}');
    writeLegacy('bot-a/gateway/weixin/wx1.json', '{"ctx":{}}');
    writeLegacy('bot-a/attachments/inbound/telegram/1_photo', 'bin');

    const result = migrateLegacyAgentChannelData();

    expect(result.copied).toBe(4);
    expect(result.skipped).toBe(0);
    expect(fs.readFileSync(path.join(sharedAgents, 'bot-a/channels/telegram/connection.json'), 'utf8')).toBe('{"label":"tg"}');
    expect(fs.readFileSync(path.join(sharedAgents, 'bot-a/connector-secrets/telegram.json'), 'utf8')).toBe('{"token":"t"}');
    expect(fs.readFileSync(path.join(sharedAgents, 'bot-a/gateway/weixin/wx1.json'), 'utf8')).toBe('{"ctx":{}}');
    expect(fs.readFileSync(path.join(sharedAgents, 'bot-a/attachments/inbound/telegram/1_photo'), 'utf8')).toBe('bin');
  });

  it('never clobbers a file that already exists at the target', () => {
    writeLegacy('bot-a/channels/telegram/connection.json', 'legacy');
    writeLegacy('bot-a/connector-secrets/telegram.json', 'legacy');
    const sharedDir = path.join(sharedAgents, 'bot-a/channels/telegram');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'connection.json'), 'shared');
    // Secret not present at target — must be copied even when a sibling won.
    const result = migrateLegacyAgentChannelData();

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(fs.readFileSync(path.join(sharedDir, 'connection.json'), 'utf8')).toBe('shared');
    expect(fs.readFileSync(path.join(sharedAgents, 'bot-a/connector-secrets/telegram.json'), 'utf8')).toBe('legacy');
  });

  it('is idempotent: a second run copies nothing', () => {
    writeLegacy('bot-a/channels/telegram/connection.json', '{"label":"tg"}');
    migrateLegacyAgentChannelData();
    const second = migrateLegacyAgentChannelData();
    expect(second.copied).toBe(0);
  });

  it('skips dot directories and non-channel subdirectories', () => {
    writeLegacy('.deleted/123-bot-a/profile.json');
    writeLegacy('bot-b/profile.json');
    writeLegacy('bot-b/settings.json');
    writeLegacy('bot-b/sessions/active.jsonl');

    const result = migrateLegacyAgentChannelData();

    expect(result.copied).toBe(0);
    expect(fs.existsSync(path.join(sharedAgents, 'bot-b'))).toBe(false);
    expect(fs.existsSync(path.join(sharedAgents, '.deleted'))).toBe(false);
  });

  it('is a no-op when the legacy root does not exist', () => {
    fs.rmSync(legacyAgents, { recursive: true, force: true });
    const result = migrateLegacyAgentChannelData();
    expect(result.legacyRoot).toBeNull();
    expect(result.copied).toBe(0);
  });
});
