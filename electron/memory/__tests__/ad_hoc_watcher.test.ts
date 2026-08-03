import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { scanAdHocChanges } from '../ad_hoc_watcher';

interface AdHocEnv {
  adHocDir: string;
  db: DatabaseType;
  cleanup: () => void;
}

function makeEnv(): AdHocEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-'));
  const adHocDir = path.join(root, 'extensions', 'ad_hoc');
  fs.mkdirSync(adHocDir, { recursive: true });
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE curation_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','abandoned'))
    );
    CREATE TABLE curation_run_inputs (
      run_id TEXT NOT NULL,
      input_kind TEXT NOT NULL,
      input_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      output_updated_at INTEGER NOT NULL,
      disposition TEXT,
      PRIMARY KEY (run_id, input_kind, input_key, content_hash),
      FOREIGN KEY (run_id) REFERENCES curation_runs(run_id)
    );
  `);
  return {
    adHocDir,
    db,
    cleanup: () => {
      db.close();
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function writeNote(dir: string, name: string, content: string): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function markConsumed(db: DatabaseType, inputKey: string, contentHash: string): void {
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO curation_runs (run_id, status) VALUES (?, ?)').run(runId, 'succeeded');
  db.prepare(
    'INSERT INTO curation_run_inputs (run_id, input_kind, input_key, content_hash, output_updated_at, disposition) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(runId, 'ad_hoc', inputKey, contentHash, Date.now(), 'absorbed');
}

describe('scanAdHocChanges', () => {
  let env: AdHocEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('returns a new ad-hoc file as eligible', async () => {
    const filePath = writeNote(env.adHocDir, 'notes-2026-08-03.md', '# Notes\n\nUse Playwright MCP for UI verification.');
    const result = await scanAdHocChanges(env.db, env.adHocDir);
    expect(result).toHaveLength(1);
    expect(result[0].inputKind).toBe('ad_hoc');
    expect(result[0].inputKey).toBe('extensions/ad_hoc/notes-2026-08-03.md');
    expect(result[0].sourcePath).toBe(filePath);
    expect(result[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('skips a file whose (input_key, content_hash) was already consumed by a succeeded run', async () => {
    const content = '# Notes\n\nUse Playwright MCP for UI verification.';
    const filePath = writeNote(env.adHocDir, 'notes-2026-08-03.md', content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    markConsumed(env.db, 'extensions/ad_hoc/notes-2026-08-03.md', hash);

    const result = await scanAdHocChanges(env.db, env.adHocDir);
    expect(result).toEqual([]);
  });

  it('re-eligibility: a modified file (new hash) is returned even if the old hash was consumed', async () => {
    const oldContent = '# Notes\n\nOld.';
    writeNote(env.adHocDir, 'notes.md', oldContent);
    const oldHash = crypto.createHash('sha256').update(oldContent).digest('hex');
    markConsumed(env.db, 'extensions/ad_hoc/notes.md', oldHash);

    // Modify the file.
    const newContent = '# Notes\n\nNew.';
    writeNote(env.adHocDir, 'notes.md', newContent);

    const result = await scanAdHocChanges(env.db, env.adHocDir);
    expect(result).toHaveLength(1);
    const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
    expect(result[0].contentHash).toBe(newHash);
  });

  it('returns an empty array when the ad_hoc directory does not exist', async () => {
    const result = await scanAdHocChanges(env.db, path.join(env.adHocDir, 'missing'));
    expect(result).toEqual([]);
  });

  it('ignores non-markdown files', async () => {
    writeNote(env.adHocDir, 'image.png', 'not really a png');
    writeNote(env.adHocDir, 'notes.md', '# Real notes');
    const result = await scanAdHocChanges(env.db, env.adHocDir);
    expect(result).toHaveLength(1);
    expect(result[0].inputKey).toBe('extensions/ad_hoc/notes.md');
  });
});