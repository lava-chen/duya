import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BOT_PROFILE_SCHEMA_VERSION,
  readBotProfile,
  writeBotProfile,
  type BotProfile,
} from '../bot-profile';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bot-profile-'));
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = tmpDir();
  file = path.join(dir, 'profile.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bot-profile (Plan 485 P1.3)', () => {
  it('readBotProfile returns null for a missing file', () => {
    expect(readBotProfile(file)).toBeNull();
  });

  it('readBotProfile returns null for corrupt json', () => {
    fs.writeFileSync(file, '{not json', 'utf8');
    expect(readBotProfile(file)).toBeNull();
  });

  it('round-trips a full profile with defaults applied on write', () => {
    const written = writeBotProfile(file, {
      name: 'Frontend Expert',
      title: '  前端架构与 React 专家  ',
      description: 'desc',
      avatarColor: '#1a73e8',
    });
    expect(written.schemaVersion).toBe(BOT_PROFILE_SCHEMA_VERSION);
    // title/avatar tokens are trimmed on write.
    expect(written.title).toBe('前端架构与 React 专家');

    const read = readBotProfile(file);
    expect(read).toEqual(written);
  });

  it('fills defaults for missing optional fields on read', () => {
    fs.writeFileSync(file, JSON.stringify({ name: 'Only Name' }), 'utf8');
    const read = readBotProfile(file);
    expect(read).not.toBeNull();
    expect(read!.name).toBe('Only Name');
    expect(read!.title).toBe('');
    expect(read!.description).toBe('');
    expect(read!.schemaVersion).toBe(BOT_PROFILE_SCHEMA_VERSION); // missing → current
  });

  it('ignores the legacy avatarShape/avatarImage/avatarEmoji fields on read', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: 'Legacy',
        title: '',
        description: '',
        avatarShape: 'hex',
        avatarImage: 'avatar.png',
        avatarEmoji: '🤖',
        avatarColor: 'blue',
      }),
      'utf8',
    );
    const read = readBotProfile(file);
    expect(read!.avatarColor).toBe('blue');
    expect('avatarShape' in read!).toBe(false);
    expect('avatarImage' in read!).toBe(false);
    expect('avatarEmoji' in read!).toBe(false);
  });

  it('creates the parent directory on write', () => {
    const nested = path.join(dir, 'a', 'b', 'profile.json');
    writeBotProfile(nested, { name: 'Nested', title: '', description: '' });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('writes atomically (no leftover tmp files)', () => {
    writeBotProfile(file, { name: 'Atomic', title: '', description: '' });
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('invokes the migration hook when schemaVersion differs', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 0, name: 'Old', title: '', description: '' }),
      'utf8',
    );
    const migrated = readBotProfile(file, (profile) => ({
      ...profile,
      schemaVersion: BOT_PROFILE_SCHEMA_VERSION,
      name: `${profile.name}-migrated`,
    }));
    expect(migrated).not.toBeNull();
    expect(migrated!.schemaVersion).toBe(BOT_PROFILE_SCHEMA_VERSION);
    expect(migrated!.name).toBe('Old-migrated');
  });

  it('does not run the migration hook for current-version files', () => {
    writeBotProfile(file, { name: 'Current', title: '', description: '' });
    let hookCalls = 0;
    const read = readBotProfile(file, (p) => {
      hookCalls += 1;
      return p;
    });
    expect(read).not.toBeNull();
    expect(hookCalls).toBe(0);
  });

  it('keeps old version untouched with the default (identity) migration', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 9, name: 'V9', title: '', description: '' }),
      'utf8',
    );
    const read = readBotProfile(file); // default hook = identity
    expect(read!.schemaVersion).toBe(9);
    expect(read!.name).toBe('V9');
  });

  it('preserves a real persisted profile across read/write cycles', () => {
    const first: BotProfile = writeBotProfile(file, {
      name: 'Alpha',
      title: '文档助手',
      description: 'Org knowledge base',
    });
    const second = writeBotProfile(file, first);
    const third = readBotProfile(file);
    expect(third).toEqual(first);
    expect(third).toEqual(second);
  });
});
