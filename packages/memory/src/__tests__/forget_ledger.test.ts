/**
 * Forget ledger (framework plan S5).
 *
 * One durable file under the memory root carries both halves of "forget is
 * immediate": a monotonic revision (the recall gate folded into the frozen
 * prompt cache key) and the tombstone dedupe keys (merged into Stage 1 so an
 * old summary cannot recreate the fact).
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
    expect(readForgetLedgerSync(root)).toEqual({ revision: 0, keys: [] });
    expect(readRecallRevisionSync(root)).toBe(0);
    expect(readForgottenKeysSync(root)).toEqual([]);
  });

  it('bumps the revision and appends normalized, deduped keys', () => {
    recordForgetSync(root, ['Preference:Dark Mode']);
    const second = recordForgetSync(root, [' preference:dark mode ', 'fact:alpha']);

    expect(second.revision).toBe(2);
    expect(second.keys).toEqual(['fact:alpha', 'preference:dark mode']);
    expect(readRecallRevisionSync(root)).toBe(2);

    const onDisk = JSON.parse(fs.readFileSync(forgetLedgerPath(root), 'utf8')) as {
      version: number;
      revision: number;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.revision).toBe(2);
    expect(fs.existsSync(path.join(root, FORGET_LEDGER_FILENAME))).toBe(true);
  });

  it('bumps even when no key is supplied (gate-only forget)', () => {
    expect(recordForgetSync(root, []).revision).toBe(1);
    expect(recordForgetSync(root, []).revision).toBe(2);
    expect(readForgottenKeysSync(root)).toEqual([]);
  });

  it('ignores a corrupt ledger and recovers on the next record', () => {
    fs.writeFileSync(forgetLedgerPath(root), '{not json', 'utf8');
    expect(readForgetLedgerSync(root)).toEqual({ revision: 0, keys: [] });
    expect(recordForgetSync(root, ['fact:alpha'])).toEqual({
      revision: 1,
      keys: ['fact:alpha'],
    });
  });

  it('merges tombstones into a dedupe set without losing base keys', () => {
    recordForgetSync(root, ['fact:forgotten']);
    const merged = withForgottenKeys(['fact:active', 'fact:forgotten'], root);
    expect(merged).toEqual(['fact:active', 'fact:forgotten']);
  });

  it('keeps base keys when the memory root is empty', () => {
    expect(withForgottenKeys(['fact:active'], '')).toEqual(['fact:active']);
  });
});
