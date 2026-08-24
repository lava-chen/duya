/**
 * Unit tests for file-snapshot-restore (plan 429 #3 rewind linkage).
 *
 * Covers metadata extraction from tool-result payloads, per-path collapsing
 * (oldest pre-image wins), and end-to-end restore against real temp
 * directories including integrity verification and failure counting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  extractPreImagesFromMetadata,
  collectPreImages,
  collapseOldestPreImages,
  restorePreImages,
  restoreFilesForEvents,
  type PreImageRef,
} from '../file-snapshot-restore';

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('extractPreImagesFromMetadata', () => {
  it('extracts Edit/Write shape (filePath + preImageSha)', () => {
    const refs = extractPreImagesFromMetadata({
      filePath: 'C:\\work\\a.ts',
      preImageSha: sha('old'),
    });
    expect(refs).toEqual([{ filePath: 'C:\\work\\a.ts', sha: sha('old') }]);
  });

  it('extracts ApplyPatch multi-file shape', () => {
    const refs = extractPreImagesFromMetadata({
      fileSnapshots: [
        { path: '/w/a.ts', preImageSha: sha('a-old') },
        { path: '/w/b.ts', preImageSha: sha('b-old') },
      ],
    });
    expect(refs).toEqual([
      { filePath: '/w/a.ts', sha: sha('a-old') },
      { filePath: '/w/b.ts', sha: sha('b-old') },
    ]);
  });

  it('rejects relative paths and malformed hashes', () => {
    expect(
      extractPreImagesFromMetadata({ filePath: 'rel/a.ts', preImageSha: sha('x') }),
    ).toEqual([]);
    expect(
      extractPreImagesFromMetadata({ filePath: '/w/a.ts', preImageSha: 'not-a-hash' }),
    ).toEqual([]);
    expect(extractPreImagesFromMetadata(null)).toEqual([]);
    expect(extractPreImagesFromMetadata('nope')).toEqual([]);
  });

  it('ignores unrelated metadata keys (browserResults etc.)', () => {
    expect(
      extractPreImagesFromMetadata({ browserResults: { big: 'payload' }, token_usage: '{}' }),
    ).toEqual([]);
  });
});

describe('collectPreImages', () => {
  it('reads metadata from the AgentMessage entry shape', () => {
    const payload = {
      type: 'message',
      id: 'm1',
      message: { role: 'tool', content: '', metadata: { filePath: '/w/a.ts', preImageSha: sha('v') } },
    };
    expect(collectPreImages(payload)).toEqual([{ filePath: '/w/a.ts', sha: sha('v') }]);
  });

  it('falls back to a flat metadata field (legacy shape)', () => {
    const payload = { metadata: { fileSnapshots: [{ path: '/w/b.ts', preImageSha: sha('w') }] } };
    expect(collectPreImages(payload)).toEqual([{ filePath: '/w/b.ts', sha: sha('w') }]);
  });

  it('returns empty for non-tool payloads and garbage', () => {
    expect(collectPreImages({ message: { role: 'user', content: 'hi' } })).toEqual([]);
    expect(collectPreImages(null)).toEqual([]);
    expect(collectPreImages(42)).toEqual([]);
  });
});

describe('collapseOldestPreImages', () => {
  it('keeps only the oldest ref per path, in first-seen order', () => {
    const refs: PreImageRef[] = [
      // Events oldest-first: a.ts edited twice, b.ts once, a.ts again.
      { filePath: '/w/a.ts', sha: sha('a-v1') },
      { filePath: '/w/b.ts', sha: sha('b-v1') },
      { filePath: '/w/a.ts', sha: sha('a-v2') },
    ];
    expect(collapseOldestPreImages(refs)).toEqual([
      { filePath: '/w/a.ts', sha: sha('a-v1') },
      { filePath: '/w/b.ts', sha: sha('b-v1') },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(collapseOldestPreImages([])).toEqual([]);
  });
});

describe('restorePreImages / restoreFilesForEvents', () => {
  let tmp: string;
  let snapshotRoot: string;
  let workspace: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-restore-'));
    snapshotRoot = path.join(tmp, 'snapshots');
    workspace = path.join(tmp, 'ws');
    await fs.mkdir(snapshotRoot, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function putBlob(content: string): Promise<string> {
    const address = sha(content);
    await fs.writeFile(path.join(snapshotRoot, `${address}.blob`), content, 'utf8');
    return address;
  }

  it('writes blob content back to the recorded absolute path', async () => {
    const target = path.join(workspace, 'a.ts');
    const address = await putBlob('original');

    const outcome = await restorePreImages([{ filePath: target, sha: address }], snapshotRoot);
    expect(outcome.restoredFiles).toEqual([target]);
    expect(outcome.failedCount).toBe(0);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });

  it('creates missing parent directories', async () => {
    const target = path.join(workspace, 'deep', 'nested', 'c.ts');
    const address = await putBlob('nested-content');

    const outcome = await restorePreImages([{ filePath: target, sha: address }], snapshotRoot);
    expect(outcome.restoredFiles).toEqual([target]);
    expect(await fs.readFile(target, 'utf8')).toBe('nested-content');
  });

  it('skips corrupted blobs (hash mismatch) without writing', async () => {
    const target = path.join(workspace, 'd.ts');
    const fakeSha = sha('intended');
    await fs.writeFile(path.join(snapshotRoot, `${fakeSha}.blob`), 'corrupted-bytes', 'utf8');

    const outcome = await restorePreImages([{ filePath: target, sha: fakeSha }], snapshotRoot);
    expect(outcome.restoredFiles).toEqual([]);
    expect(outcome.failedCount).toBe(1);
    await expect(fs.readFile(target, 'utf8')).rejects.toThrow();
  });

  it('counts missing blobs as failures', async () => {
    const outcome = await restorePreImages(
      [{ filePath: path.join(workspace, 'e.ts'), sha: sha('never-stored') }],
      snapshotRoot,
    );
    expect(outcome.restoredFiles).toEqual([]);
    expect(outcome.failedCount).toBe(1);
  });

  it('restores through event payloads; oldest edit wins for repeated paths', async () => {
    const target = path.join(workspace, 'f.ts');

    // Simulate a session: two edits of f.ts plus one unrelated message.
    const v0 = 'state before everything';
    const v1 = 'state after first edit';
    const events = [
      {
        payload: JSON.stringify({
          type: 'message',
          id: 'm1',
          message: { role: 'tool', metadata: { filePath: target, preImageSha: await putBlob(v0) } },
        }),
      },
      { payload: JSON.stringify({ type: 'message', id: 'm2', message: { role: 'user', content: 'next' } }) },
      {
        payload: JSON.stringify({
          type: 'message',
          id: 'm3',
          message: { role: 'tool', metadata: { filePath: target, preImageSha: await putBlob(v1) } },
        }),
      },
    ];

    // The file currently holds the post-edit state.
    await fs.writeFile(target, v1, 'utf8');

    const outcome = await restoreFilesForEvents(events, snapshotRoot);
    expect(outcome.restoredFiles).toEqual([target]);
    expect(await fs.readFile(target, 'utf8')).toBe(v0);
  });

  it('tolerates unparseable payloads', async () => {
    const outcome = await restoreFilesForEvents(
      [{ payload: '{broken json' }],
      snapshotRoot,
    );
    expect(outcome.restoredFiles).toEqual([]);
    expect(outcome.failedCount).toBe(0);
  });
});
