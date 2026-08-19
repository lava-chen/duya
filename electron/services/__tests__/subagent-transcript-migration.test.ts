/**
 * Unit tests for the legacy subagent-transcript migration
 * (electron/services/subagent-transcript-migration.ts).
 *
 * The migration copies (never moves) JSONL transcripts from the pre-28c8c8bb
 * app-data directory into ~/.duya/subagent-transcripts so the canonical root
 * holds every transcript while historical notification paths keep resolving.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateSubagentTranscripts, resolveLegacyTranscriptDir } from '../subagent-transcript-migration';

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    HOME: '/home/test-user',
    USERPROFILE: 'C:\\Users\\TestUser',
    APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
    XDG_DATA_HOME: '/home/test-user/.local/share',
    ...overrides,
  };
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stm-'));
}

describe('subagent transcript migration', () => {
  let legacyRoot: string;
  let targetRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    legacyRoot = makeTmp();
    targetRoot = makeTmp();
    env = makeEnv();
  });

  afterEach(() => {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });

  it('copies legacy transcript files into the target directory (win32)', () => {
    const legacyDir = path.join(legacyRoot, 'DUYA', 'subagent-transcripts');
    const targetDir = path.join(targetRoot, '.duya', 'subagent-transcripts');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'abc.jsonl'), '{"at":1}\n');
    fs.writeFileSync(path.join(legacyDir, 'def.jsonl'), '{"at":2}\n');

    const result = migrateSubagentTranscripts({
      env: { ...env, APPDATA: legacyRoot, USERPROFILE: targetRoot },
      platform: 'win32',
    });

    expect(result.legacyDir).toBe(legacyDir);
    expect(result.targetDir).toBe(targetDir);
    expect(result.migrated).toBe(2);
    expect(result.failed).toBe(0);
    expect(fs.readFileSync(path.join(targetDir, 'abc.jsonl'), 'utf8')).toBe('{"at":1}\n');
    expect(fs.readFileSync(path.join(targetDir, 'def.jsonl'), 'utf8')).toBe('{"at":2}\n');
    // Originals stay put so historical notification paths keep resolving.
    expect(fs.existsSync(path.join(legacyDir, 'abc.jsonl'))).toBe(true);
  });

  it('resolves win32 legacy dir from APPDATA and copies nothing when empty', () => {
    fs.mkdirSync(path.join(legacyRoot, 'DUYA', 'subagent-transcripts'), { recursive: true });

    const result = migrateSubagentTranscripts({
      env: { ...env, APPDATA: legacyRoot },
      platform: 'win32',
    });

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('migrates files to a hermetic target on linux (HOME-driven)', () => {
    const legacyDir = path.join(legacyRoot, 'DUYA', 'subagent-transcripts');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'abc.jsonl'), '{"at":1}\n');
    fs.writeFileSync(path.join(legacyDir, 'note.txt'), 'not a transcript');

    const linuxEnv = makeEnv({ HOME: targetRoot, XDG_DATA_HOME: legacyRoot });
    const result = migrateSubagentTranscripts({ env: linuxEnv, platform: 'linux' });

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);
    const copied = path.join(targetRoot, '.duya', 'subagent-transcripts', 'abc.jsonl');
    expect(fs.readFileSync(copied, 'utf8')).toBe('{"at":1}\n');
    // Only JSONL transcripts are copied.
    expect(fs.existsSync(path.join(targetRoot, '.duya', 'subagent-transcripts', 'note.txt'))).toBe(false);
    // Originals stay put so historical notification paths keep resolving.
    expect(fs.existsSync(path.join(legacyDir, 'abc.jsonl'))).toBe(true);
  });

  it('is idempotent: files already at the target are skipped', () => {
    const legacyDir = path.join(legacyRoot, 'DUYA', 'subagent-transcripts');
    const targetDir = path.join(targetRoot, '.duya', 'subagent-transcripts');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'abc.jsonl'), '{"at":1}\n');
    fs.writeFileSync(path.join(targetDir, 'abc.jsonl'), 'already here');

    const env2 = makeEnv({ HOME: targetRoot, XDG_DATA_HOME: legacyRoot });
    const first = migrateSubagentTranscripts({ env: env2, platform: 'linux' });
    const second = migrateSubagentTranscripts({ env: env2, platform: 'linux' });

    expect(first.migrated).toBe(0);
    expect(first.skipped).toBe(1);
    expect(second.skipped).toBe(1);
    expect(fs.readFileSync(path.join(targetDir, 'abc.jsonl'), 'utf8')).toBe('already here');
  });

  it('is a no-op when DUYA_APP_DATA_PATH is set (agent root overridden)', () => {
    fs.mkdirSync(path.join(legacyRoot, 'DUYA', 'subagent-transcripts'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'DUYA', 'subagent-transcripts', 'abc.jsonl'), 'x');

    const result = migrateSubagentTranscripts({
      env: { ...env, APPDATA: legacyRoot, DUYA_APP_DATA_PATH: '/custom/root' },
      platform: 'win32',
    });

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(fs.existsSync(path.join('/custom/root', 'subagent-transcripts'))).toBe(false);
  });

  it('is a no-op in test mode (DUYA_TEST=1)', () => {
    fs.mkdirSync(path.join(legacyRoot, 'DUYA', 'subagent-transcripts'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'DUYA', 'subagent-transcripts', 'abc.jsonl'), 'x');

    const result = migrateSubagentTranscripts({
      env: { ...env, APPDATA: legacyRoot, DUYA_TEST: '1' },
      platform: 'win32',
    });

    expect(result.migrated).toBe(0);
  });

  it('returns null legacyDir on unknown platforms and does nothing', () => {
    const result = migrateSubagentTranscripts({
      env,
      platform: 'freebsd' as NodeJS.Platform,
    });
    expect(result.legacyDir).toBeNull();
    expect(result.migrated).toBe(0);
  });

  it('tolerates a missing legacy directory (ENOENT)', () => {
    const result = migrateSubagentTranscripts({
      env: { ...env, APPDATA: path.join(legacyRoot, 'does-not-exist') },
      platform: 'win32',
    });
    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('resolveLegacyTranscriptDir mirrors the old getAppDataDir fallbacks', () => {
    expect(
      resolveLegacyTranscriptDir(
        makeEnv({ APPDATA: undefined }),
        'win32',
      ),
    ).toBe(path.join('C:\\Users\\TestUser', 'AppData', 'Roaming', 'DUYA', 'subagent-transcripts'));
    expect(resolveLegacyTranscriptDir(makeEnv(), 'darwin')).toBe(
      path.join('/home/test-user', 'Library', 'Application Support', 'DUYA', 'subagent-transcripts'),
    );
    expect(resolveLegacyTranscriptDir(makeEnv({ XDG_DATA_HOME: undefined }), 'linux')).toBe(
      path.join('/home/test-user', '.local', 'share', 'DUYA', 'subagent-transcripts'),
    );
  });
});
