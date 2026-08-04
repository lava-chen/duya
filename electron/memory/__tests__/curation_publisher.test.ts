import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  writeJournal,
  readJournal,
  preparePublication,
  executePublication,
  recoverPublication,
  type PublicationJournal,
  type RecoveryResult,
} from '../curation_publisher';
import { generateMemoryMd } from '../../../packages/agent/src/memory-state/curation_projection';

interface PubEnv {
  stagingDir: string;
  journalPath: string;
  cleanup: () => void;
}

function makeEnv(): PubEnv {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-staging-'));
  return {
    stagingDir,
    journalPath: path.join(stagingDir, 'publication.journal.json'),
    cleanup: () => {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function makeJournal(overrides?: Partial<PublicationJournal>): PublicationJournal {
  return {
    run_id: 'run-1',
    generation: 1,
    old_manifest_hash: 'old-hash',
    new_manifest_hash: 'new-hash',
    old_policy_version: 3,
    new_policy_version: 4,
    old_layout_version: 2,
    new_layout_version: 2,
    backup_dir: 'memory-staging/run-1/backup/',
    steps: [
      { step: 'backup_old', path: 'memory-staging/run-1/backup/', status: 'done', ts: '2026-08-03T10:00:00Z' },
      { step: 'move_leaf', files: ['items/preference/x.md'], status: 'pending', ts: null },
      { step: 'move_config', files: [], status: 'pending', ts: null },
      { step: 'regenerate_indexes', files: ['entities/people/index.md'], status: 'pending', ts: null },
      { step: 'regenerate_MEMORY_md', status: 'pending', ts: null },
      { step: 'regenerate_summary_md', status: 'pending', ts: null },
      { step: 'swap_manifest', status: 'pending', ts: null },
    ],
    ...overrides,
  };
}

describe('writeJournal + readJournal', () => {
  let env: PubEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. write then read — round-trip preserves all fields', () => {
    const journal = makeJournal();
    writeJournal(env.journalPath, journal);

    const read = readJournal(env.journalPath);
    expect(read).not.toBeNull();
    expect(read!.run_id).toBe('run-1');
    expect(read!.generation).toBe(1);
    expect(read!.old_manifest_hash).toBe('old-hash');
    expect(read!.new_manifest_hash).toBe('new-hash');
    expect(read!.old_policy_version).toBe(3);
    expect(read!.new_policy_version).toBe(4);
    expect(read!.old_layout_version).toBe(2);
    expect(read!.new_layout_version).toBe(2);
    expect(read!.backup_dir).toBe('memory-staging/run-1/backup/');
    expect(read!.steps).toHaveLength(7);
    expect(read!.steps[0].step).toBe('backup_old');
    expect(read!.steps[0].status).toBe('done');
    expect(read!.steps[1].step).toBe('move_leaf');
    expect(read!.steps[1].files).toEqual(['items/preference/x.md']);
    expect(read!.steps[1].status).toBe('pending');
    expect(read!.steps[1].ts).toBeNull();
  });

  it('2. read on non-existent journal returns null', () => {
    const read = readJournal(path.join(env.stagingDir, 'no-such.journal.json'));
    expect(read).toBeNull();
  });

  it('3. write creates parent directories if needed', () => {
    const deepPath = path.join(env.stagingDir, 'nested', 'dir', 'publication.journal.json');
    writeJournal(deepPath, makeJournal());
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  it('4. write overwrites existing journal (update on each step)', () => {
    const journal = makeJournal();
    writeJournal(env.journalPath, journal);

    // Simulate advancing a step.
    journal.steps[1].status = 'done';
    journal.steps[1].ts = '2026-08-03T10:00:01Z';
    writeJournal(env.journalPath, journal);

    const read = readJournal(env.journalPath);
    expect(read!.steps[1].status).toBe('done');
    expect(read!.steps[1].ts).toBe('2026-08-03T10:00:01Z');
  });
});

function setupLiveMemory(liveMemoryRoot: string): void {
  fs.mkdirSync(path.join(liveMemoryRoot, 'items', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'),
    '---\ncanonical_key: "preference:old-pref"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# Old Pref\n\nOld pref body.'
  );
  fs.mkdirSync(path.join(liveMemoryRoot, 'entities', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(liveMemoryRoot, 'entities', 'people', 'alice.md'),
    '---\ncanonical_key: "person:alice"\nclaim_type: "person"\nstatus: "active"\n---\n\n# Alice\n\nAlice bio.'
  );
  fs.writeFileSync(
    path.join(liveMemoryRoot, '.manifest.json'),
    JSON.stringify({ version: 1, generation: 1, files: {} })
  );
}

function setupStagingMemory(stagingDir: string): void {
  // Staging memory contains the candidate (new) canonical files.
  const stagingMemory = path.join(stagingDir, 'memory');
  fs.mkdirSync(path.join(stagingMemory, 'items', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(stagingMemory, 'items', 'preference', 'new-pref.md'),
    '---\ncanonical_key: "preference:new-pref"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# New Pref\n\nNew pref body.'
  );
  fs.writeFileSync(
    path.join(stagingMemory, 'items', 'preference', 'old-pref.md'),
    '---\ncanonical_key: "preference:old-pref"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# Old Pref Updated\n\nUpdated body.'
  );
  fs.mkdirSync(path.join(stagingMemory, 'entities', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(stagingMemory, 'entities', 'people', 'alice.md'),
    '---\ncanonical_key: "person:alice"\nclaim_type: "person"\nstatus: "active"\n---\n\n# Alice\n\nUpdated Alice bio.'
  );
}

describe('preparePublication', () => {
  let env: PubEnv;
  let liveMemoryRoot: string;
  let liveConfigRoot: string;

  beforeEach(() => {
    env = makeEnv();
    liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-memory-'));
    liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-config-'));
    setupLiveMemory(liveMemoryRoot);
    setupStagingMemory(env.stagingDir);
    fs.mkdirSync(liveConfigRoot, { recursive: true });
    fs.writeFileSync(path.join(liveConfigRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1, entities: {} }));
  });

  afterEach(() => {
    env.cleanup();
    for (const d of [liveMemoryRoot, liveConfigRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('1. backs up live files that will be replaced', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    // backup dir should contain the old preference file.
    const backupDir = path.join(env.stagingDir, 'backup');
    expect(fs.existsSync(path.join(backupDir, 'items', 'preference', 'old-pref.md'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'entities', 'people', 'alice.md'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, '.manifest.json'))).toBe(true);

    expect(journal.backup_dir).toContain('backup');
  });

  it('2. generates candidate projections in staging/candidate/', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    const candidateDir = path.join(env.stagingDir, 'candidate');
    expect(fs.existsSync(path.join(candidateDir, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(candidateDir, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(candidateDir, 'entities', 'people', 'index.md'))).toBe(true);

    // MEMORY.md contains the new canonical key.
    const memoryMd = fs.readFileSync(path.join(candidateDir, 'MEMORY.md'), 'utf8');
    expect(memoryMd).toContain('preference:new-pref');
  });

  it('3. writes journal with all steps pending (except backup_old=done)', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    expect(journal.run_id).toBe('run-1');
    expect(journal.generation).toBe(2);
    expect(journal.old_manifest_hash).toBe('old-hash');
    expect(journal.steps).toHaveLength(7);

    // backup_old is done (it was just performed).
    const backupStep = journal.steps.find((s) => s.step === 'backup_old')!;
    expect(backupStep.status).toBe('done');
    expect(backupStep.ts).not.toBeNull();

    // All other steps are pending.
    for (const step of journal.steps) {
      if (step.step !== 'backup_old') {
        expect(step.status).toBe('pending');
        expect(step.ts).toBeNull();
      }
    }

    // Journal file exists on disk.
    expect(fs.existsSync(path.join(env.stagingDir, 'publication.journal.json'))).toBe(true);
    const read = readJournal(path.join(env.stagingDir, 'publication.journal.json'));
    expect(read).not.toBeNull();
    expect(read!.run_id).toBe('run-1');
  });

  it('4. candidate MEMORY.md respects 64KiB cap', async () => {
    // Write many files in staging to test cap.
    const stagingMemory = path.join(env.stagingDir, 'memory');
    for (let i = 0; i < 100; i++) {
      const slug = `big-${i}`;
      fs.writeFileSync(
        path.join(stagingMemory, 'items', 'preference', `${slug}.md`),
        `---\ncanonical_key: "preference:${slug}"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# ${slug}\n\n${'x'.repeat(800)}`
      );
    }

    await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    const memoryMd = fs.readFileSync(path.join(env.stagingDir, 'candidate', 'MEMORY.md'), 'utf8');
    expect(Buffer.byteLength(memoryMd, 'utf8')).toBeLessThanOrEqual(64 * 1024 + 100);
  });
});

describe('executePublication', () => {
  let env: PubEnv;
  let liveMemoryRoot: string;
  let liveConfigRoot: string;

  beforeEach(() => {
    env = makeEnv();
    liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-exec-'));
    liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-exec-'));
    setupLiveMemory(liveMemoryRoot);
    setupStagingMemory(env.stagingDir);
    fs.mkdirSync(liveConfigRoot, { recursive: true });
    fs.writeFileSync(path.join(liveConfigRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1, entities: {} }));
  });

  afterEach(() => {
    env.cleanup();
    for (const d of [liveMemoryRoot, liveConfigRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('1. moves leaf canonical files from staging to live', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    // New file from staging is now in live.
    expect(fs.existsSync(path.join(liveMemoryRoot, 'items', 'preference', 'new-pref.md'))).toBe(true);
    // Updated file content is in live.
    const liveContent = fs.readFileSync(
      path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'), 'utf8'
    );
    expect(liveContent).toContain('Updated body');
  });

  it('2. regenerates MEMORY.md in live from candidate', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const liveMemoryMd = fs.readFileSync(path.join(liveMemoryRoot, 'MEMORY.md'), 'utf8');
    expect(liveMemoryMd).toContain('preference:new-pref');
  });

  it('3. regenerates summary.md and index.md in live', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    expect(fs.existsSync(path.join(liveMemoryRoot, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(liveMemoryRoot, 'entities', 'people', 'index.md'))).toBe(true);
  });

  it('4. swaps manifest atomically — .manifest.json reflects new generation', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 42,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(liveMemoryRoot, '.manifest.json'), 'utf8'));
    expect(manifest.generation).toBe(42);
  });

  it('5. journal on disk shows all steps done after execution', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const read = readJournal(path.join(env.stagingDir, 'publication.journal.json'));
    expect(read).not.toBeNull();
    for (const step of read!.steps) {
      expect(step.status).toBe('done');
      expect(step.ts).not.toBeNull();
    }
  });

  it('6. removes files from live that were deleted in staging', async () => {
    // Live has old-pref.md; remove it from staging to simulate deletion.
    fs.unlinkSync(path.join(env.stagingDir, 'memory', 'items', 'preference', 'old-pref.md'));

    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    // old-pref.md should no longer exist in live.
    expect(fs.existsSync(path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'))).toBe(false);
  });
});

describe('recoverPublication', () => {
  let env: PubEnv;
  let liveMemoryRoot: string;
  let liveConfigRoot: string;

  beforeEach(() => {
    env = makeEnv();
    liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-recover-'));
    liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-recover-'));
    setupLiveMemory(liveMemoryRoot);
    fs.mkdirSync(liveConfigRoot, { recursive: true });
    fs.writeFileSync(path.join(liveConfigRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1, entities: {} }));
  });

  afterEach(() => {
    env.cleanup();
    for (const d of [liveMemoryRoot, liveConfigRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('1. journal not found — returns noop', async () => {
    const result = await recoverPublication(
      path.join(env.stagingDir, 'no-journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('noop');
  });

  it('2. journal prepared only (backup_old done, all else pending) — discards and marks failed', async () => {
    setupStagingMemory(env.stagingDir);
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    const result = await recoverPublication(
      path.join(env.stagingDir, 'publication.journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('discard');
    expect(result.runId).toBe('run-1');

    // Live memory is untouched (old-pref still has original content).
    const liveContent = fs.readFileSync(
      path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'), 'utf8'
    );
    expect(liveContent).toContain('Old pref body');
    expect(liveContent).not.toContain('Updated body');
  });

  it('3. journal publishing, manifest not swapped — restores from backup', async () => {
    setupStagingMemory(env.stagingDir);
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    // Simulate a crash during move_leaf: partially execute by copying
    // a staging file to live, then leave journal with move_leaf='done'
    // but swap_manifest still 'pending'.
    fs.copyFileSync(
      path.join(env.stagingDir, 'memory', 'items', 'preference', 'new-pref.md'),
      path.join(liveMemoryRoot, 'items', 'preference', 'new-pref.md')
    );
    journal.steps[1].status = 'done';
    journal.steps[1].ts = new Date().toISOString();
    writeJournal(path.join(env.stagingDir, 'publication.journal.json'), journal);

    const result = await recoverPublication(
      path.join(env.stagingDir, 'publication.journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('restore');

    // new-pref.md (which was not in the backup) should be removed.
    expect(fs.existsSync(path.join(liveMemoryRoot, 'items', 'preference', 'new-pref.md'))).toBe(false);
    // old-pref.md should have original content restored.
    const liveContent = fs.readFileSync(
      path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'), 'utf8'
    );
    expect(liveContent).toContain('Old pref body');
  });

  it('4. journal filesystem_committed (swap_manifest done) — returns finalize', async () => {
    setupStagingMemory(env.stagingDir);
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    // Execute fully so manifest is swapped.
    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const result = await recoverPublication(
      path.join(env.stagingDir, 'publication.journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('finalize');
    expect(result.runId).toBe('run-1');
  });
});