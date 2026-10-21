/**
 * Tests for content-addressed file snapshots (plan 429 #3).
 *
 * Covers:
 *  - FileSnapshotStore: content addressed, deduplicated, retrievable.
 *  - withFileSnapshot: captures pre-image before a mutation and passes the
 *    address into the callback; absent pre-image for missing files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSnapshotStore, sha256Of } from '../file-snapshot-store.js';
import { withFileSnapshot } from '../file-snapshot.js';

let root: string;
let store: FileSnapshotStore;

async function makeTmpRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-snapshot-test-'));
  return dir;
}

beforeEach(async () => {
  root = await makeTmpRoot();
  store = new FileSnapshotStore(path.join(root, 'snapshots'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FileSnapshotStore', () => {
  it('stores content under its sha256 address and reads it back', async () => {
    const content = 'hello world';
    const address = await store.put(content);
    expect(address).toBe(sha256Of(content));
    expect(await store.get(address)).toBe(content);
  });

  it('deduplicates identical content to a single blob', async () => {
    const content = 'same payload';
    const a = await store.put(content);
    const b = await store.put(content);
    expect(a).toBe(b);
    // Only one blob on disk.
    const files = await fs.readdir(path.join(root, 'snapshots'));
    expect(files).toHaveLength(1);
  });

  it('returns null for a missing address', async () => {
    expect(await store.get('deadbeef')).toBeNull();
  });

  it('reports has() correctly', async () => {
    const content = 'presence check';
    const address = await store.put(content);
    expect(await store.has(address)).toBe(true);
    expect(await store.has('deadbeef')).toBe(false);
  });

  it('is utf8 round-trip safe', async () => {
    const content = '中文 with \uFEFF BOM and trailing newline\n';
    const address = await store.put(content);
    expect(await store.get(address)).toBe(content);
  });
});

describe('withFileSnapshot', () => {
  it('captures and returns the pre-image address of an existing file', async () => {
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'ORIGINAL', 'utf8');

    const { value, preImageSha } = await withFileSnapshot(file, async (sha) => {
      expect(sha).toBeDefined();
      await fs.writeFile(file, 'CHANGED', 'utf8');
      return 'done';
    }, store);

    expect(value).toBe('done');
    expect(preImageSha).toBeDefined();
    // Snapshot holds the ORIGINAL content; the live file is now CHANGED.
    expect(await store.get(preImageSha!)).toBe('ORIGINAL');
    expect(await fs.readFile(file, 'utf8')).toBe('CHANGED');
  });

  it('returns no preImageSha for a missing file', async () => {
    const file = path.join(root, 'missing.txt');
    const { value, preImageSha } = await withFileSnapshot(file, async (sha) => {
      expect(sha).toBeUndefined();
      await fs.writeFile(file, 'NEW', 'utf8');
      return undefined;
    }, store);
    expect(value).toBeUndefined();
    expect(preImageSha).toBeUndefined();
  });

  it('never throws when the snapshot store write fails (best-effort)', async () => {
    const file = path.join(root, 'b.txt');
    await fs.writeFile(file, 'content', 'utf8');
    // Point the store at an unwritable path (a file blocks the dir creation).
    const badStore = new FileSnapshotStore(path.join(root, 'no-such-dir', 'nested'));
    await fs.writeFile(path.join(root, 'no-such-dir'), '', 'utf8');

    // The pre-image address is still computable; the failed store write must
    // not throw or surface as a tool error.
    const { value } = await withFileSnapshot(file, async () => 'ran', badStore);
    expect(value).toBe('ran');
  });
});