/**
 * Unit tests for snapshot-gc (plan 429 #3 cleanup strategy).
 *
 * Verifies the mark-and-sweep policy: blobs referenced by any rollout file
 * (or younger than the grace period) are kept; unreferenced aged blobs are
 * deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { sweepUnreferencedSnapshots } from '../snapshot-gc';

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('sweepUnreferencedSnapshots', () => {
  let tmp: string;
  let snapshotRoot: string;
  let rolloutsRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-snapshot-gc-'));
    snapshotRoot = path.join(tmp, 'snapshots');
    rolloutsRoot = path.join(tmp, 'sessions');
    await fs.mkdir(snapshotRoot, { recursive: true });
    await fs.mkdir(rolloutsRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeBlob(content: string): Promise<string> {
    const address = sha(content);
    const blobPath = path.join(snapshotRoot, `${address}.blob`);
    await fs.writeFile(blobPath, content, 'utf8');
    // Backdate past the grace period so the age filter lets it through.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(blobPath, old, old);
    return address;
  }

  async function writeRollout(relativePath: string, content: string): Promise<void> {
    const full = path.join(rolloutsRoot, relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  it('deletes unreferenced aged blobs and keeps referenced ones', async () => {
    const referencedSha = await writeBlob('still needed');
    const orphanedSha = await writeBlob('owner turn was rewound away');

    await writeRollout(
      'sessions/2026/08/20/rollout-x-s1.jsonl',
      JSON.stringify({ metadata: { preImageSha: referencedSha } }),
    );

    const result = await sweepUnreferencedSnapshots({ snapshotRoot, rolloutsRoot });
    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);

    await expect(fs.access(path.join(snapshotRoot, `${referencedSha}.blob`))).resolves.toBeUndefined();
    await expect(fs.access(path.join(snapshotRoot, `${orphanedSha}.blob`))).rejects.toThrow();
  });

  it('never deletes blobs inside the grace period', async () => {
    const youngSha = sha('just written, message not persisted yet');
    await fs.writeFile(path.join(snapshotRoot, `${youngSha}.blob`), 'fresh', 'utf8');

    const result = await sweepUnreferencedSnapshots({ snapshotRoot, rolloutsRoot });
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
  });

  it('scans nested rollout directories', async () => {
    const referencedSha = await writeBlob('deeply referenced');
    await writeRollout('sessions/2026/08/01/rollout-y-s2.jsonl', `prefix ${referencedSha} suffix`);

    const result = await sweepUnreferencedSnapshots({ snapshotRoot, rolloutsRoot });
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
  });

  it('handles missing directories gracefully', async () => {
    const result = await sweepUnreferencedSnapshots({
      snapshotRoot: path.join(tmp, 'does-not-exist'),
      rolloutsRoot: path.join(tmp, 'also-missing'),
    });
    expect(result).toEqual({ scanned: 0, deleted: 0, kept: 0 });
  });
});
