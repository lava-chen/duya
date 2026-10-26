/**
 * Forget ledger (framework plan S5).
 *
 * One durable file under the memory root carries three things: a monotonic
 * revision (the recall gate folded into the frozen prompt cache key), the
 * tombstone dedupe keys (merged into Stage 1 so an old summary cannot
 * recreate the fact) and the retired file paths (the write-ahead record
 * that makes a crash between the ledger write and the file retirement
 * recoverable instead of a silent resurrection).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FORGET_LEDGER_FILENAME,
  forgetLedgerPath,
  readForgetLedgerSync,
  readForgottenKeysSync,
  readForgottenPathsSync,
  readRecallRevisionSync,
  recordForgetSync,
  withForgottenKeys,
} from '../forget_ledger.js';

describe('forget ledger', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-forget-ledger-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('reads as revision 0 with no keys when the ledger is missing', () => {
    expect(readForgetLedgerSync(root)).toEqual({ revision: 0, entries: [] });
    expect(readRecallRevisionSync(root)).toBe(0);
    expect(readForgottenKeysSync(root)).toEqual([]);
    expect(readForgottenPathsSync(root)).toEqual([]);
  });

  it('bumps the revision and appends normalized, deduped keys', () => {
    recordForgetSync(root, [{ key: 'Preference:Dark Mode' }]);
    const second = recordForgetSync(root, [
      { key: ' preference:dark mode ' },
      { key: 'fact:alpha' },
    ]);

    expect(second.revision).toBe(2);
    expect(readForgottenKeysSync(root)).toEqual(['fact:alpha', 'preference:dark mode']);
    expect(readRecallRevisionSync(root)).toBe(2);

    const onDisk = JSON.parse(fs.readFileSync(forgetLedgerPath(root), 'utf8')) as {
      version: number;
      revision: number;
    };
    expect(onDisk.version).toBe(2);
    expect(onDisk.revision).toBe(2);
    expect(fs.existsSync(path.join(root, FORGET_LEDGER_FILENAME))).toBe(true);
  });

  it('records the retired path so a crash cannot resurrect the file', () => {
    recordForgetSync(root, [
      { key: 'prefers concise answers', path: 'agents/alpha/memory/prefers-concise-answers-abc1234567.md' },
    ]);

    expect(readForgottenPathsSync(root)).toEqual([
      'agents/alpha/memory/prefers-concise-answers-abc1234567.md',
    ]);
    // The key still blocks re-extraction.
    expect(readForgottenKeysSync(root)).toEqual(['prefers concise answers']);
  });

  it('merges paths of the same key and rejects unsafe paths', () => {
    recordForgetSync(root, [{ key: 'fact:alpha', path: 'agents/alpha/memory/a.md' }]);
    recordForgetSync(root, [{ key: 'fact:alpha', path: 'agents/alpha/memory/b.md' }]);
    recordForgetSync(root, [
      { key: 'fact:alpha', path: '../escape.md' },
      { key: 'fact:alpha', path: '/absolute.md' },
    ]);

    expect(readForgottenPathsSync(root)).toEqual([
      'agents/alpha/memory/a.md',
      'agents/alpha/memory/b.md',
    ]);
  });

  it('bumps even when no key is supplied (gate-only forget)', () => {
    expect(recordForgetSync(root, []).revision).toBe(1);
    expect(recordForgetSync(root, []).revision).toBe(2);
    expect(readForgottenKeysSync(root)).toEqual([]);
  });

  it('ignores a corrupt ledger and recovers on the next record', () => {
    fs.writeFileSync(forgetLedgerPath(root), '{not json', 'utf8');
    expect(readForgetLedgerSync(root)).toEqual({ revision: 0, entries: [] });
    expect(recordForgetSync(root, [{ key: 'fact:alpha' }]).revision).toBe(1);
    expect(readForgottenKeysSync(root)).toEqual(['fact:alpha']);
  });

  it('reads a version-1 ledger (keys only) and keeps blocking re-extraction', () => {
    fs.writeFileSync(
      forgetLedgerPath(root),
      JSON.stringify({ version: 1, revision: 3, keys: ['fact:legacy'] }),
      'utf8',
    );

    expect(readRecallRevisionSync(root)).toBe(3);
    expect(readForgottenKeysSync(root)).toEqual(['fact:legacy']);
    // No paths in a v1 ledger — nothing is hidden by path until the next forget.
    expect(readForgottenPathsSync(root)).toEqual([]);
  });

  it('merges tombstones into a dedupe set without losing base keys', () => {
    recordForgetSync(root, [{ key: 'fact:forgotten' }]);
    const merged = withForgottenKeys(['fact:active', 'fact:forgotten'], root);
    expect(merged).toEqual(['fact:active', 'fact:forgotten']);
  });

  it('keeps base keys when the memory root is empty', () => {
    expect(withForgottenKeys(['fact:active'], '')).toEqual(['fact:active']);
  });
});
