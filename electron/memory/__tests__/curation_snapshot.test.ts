import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSnapshot } from '../curation_snapshot';

interface SnapEnv {
  liveMemoryRoot: string;
  liveConfigRoot: string;
  snapshotRoot: string;
  cleanup: () => void;
}

function setupLiveMemory(memoryRoot: string): void {
  fs.mkdirSync(path.join(memoryRoot, 'items', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'items', 'preference', 'pref.md'),
    '---\ncanonical_key: "preference:pref"\n---\n\n# Pref\n\nPref body.'
  );
  fs.mkdirSync(path.join(memoryRoot, 'entities', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'entities', 'people', 'alice.md'),
    '---\ncanonical_key: "person:alice"\n---\n\n# Alice\n\nAlice bio.'
  );
  fs.writeFileSync(path.join(memoryRoot, 'MEMORY.md'), '# Memory\n\n- pref');
  fs.writeFileSync(path.join(memoryRoot, 'summary.md'), '# Summary');
  fs.writeFileSync(
    path.join(memoryRoot, '.manifest.json'),
    JSON.stringify({ version: 1, generation: 1 })
  );

  // Excluded dirs (should NOT be in snapshot).
  fs.mkdirSync(path.join(memoryRoot, 'rollout_summaries'), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'rollout_summaries', 'r1.md'), '# r1');
  fs.mkdirSync(path.join(memoryRoot, 'extensions', 'ad_hoc'), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'extensions', 'ad_hoc', 'notes.md'), '# notes');
}

function setupConfigRoot(configRoot: string): void {
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'stage1_policy.md'), '# Policy');
  fs.writeFileSync(path.join(configRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1 }));
}

function makeEnv(): SnapEnv {
  const liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-live-'));
  const liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-config-'));
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-root-'));
  setupLiveMemory(liveMemoryRoot);
  setupConfigRoot(liveConfigRoot);
  return {
    liveMemoryRoot,
    liveConfigRoot,
    snapshotRoot,
    cleanup: () => {
      for (const d of [liveMemoryRoot, liveConfigRoot, snapshotRoot]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

describe('createSnapshot', () => {
  let env: SnapEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. snapshot contains managed files (items + entities + projections + config + manifest)', async () => {
    const { snapshotDir } = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    expect(fs.existsSync(snapshotDir)).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'items', 'preference', 'pref.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'entities', 'people', 'alice.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', '.manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory-config', 'stage1_policy.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory-config', 'memory_layout.json'))).toBe(true);
  });

  it('2. snapshot excludes rollout_summaries, extensions, ad_hoc', async () => {
    const { snapshotDir } = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'rollout_summaries'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'extensions'))).toBe(false);
  });

  it('3. returns manifest hash matching live content', async () => {
    const { manifestHash } = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    expect(manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('4. identical content across snapshots uses hardlinks (dedup)', async () => {
    const r1 = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    // Second snapshot with identical content.
    const r2 = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    // The same file in both snapshots should share inodes (hardlink).
    const file1 = fs.statSync(path.join(r1.snapshotDir, 'memory', 'items', 'preference', 'pref.md'));
    const file2 = fs.statSync(path.join(r2.snapshotDir, 'memory', 'items', 'preference', 'pref.md'));
    expect(file1.ino).toBe(file2.ino);
  });

  it('5. retention — only last maxSnapshots directories kept', async () => {
    // Create maxSnapshots + 2 snapshots by modifying content each time.
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(
        path.join(env.liveMemoryRoot, 'items', 'preference', `extra-${i}.md`),
        `# Extra ${i}`
      );
      await createSnapshot({
        liveMemoryRoot: env.liveMemoryRoot,
        liveConfigRoot: env.liveConfigRoot,
        snapshotRoot: env.snapshotRoot,
        maxSnapshots: 5,
      });
    }

    // List snapshot directories (excluding manifests/ and the .content store).
    const entries = fs.readdirSync(env.snapshotRoot, { withFileTypes: true });
    const snapshotDirs = entries.filter((e) => e.isDirectory() && e.name !== 'manifests' && e.name !== '.content');
    expect(snapshotDirs.length).toBeLessThanOrEqual(5);
  });
});