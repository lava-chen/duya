import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createStaging, deleteStaging, validateStagingIntact } from '../curation_staging';

interface StagingTestEnv {
  stagingRoot: string;
  memoryRoot: string;
  configRoot: string;
  cleanup: () => void;
}

function setupMemoryRoot(memoryRoot: string): void {
  // Managed memory files (should be copied).
  fs.mkdirSync(path.join(memoryRoot, 'items', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'items', 'preference', 'verif-style.md'),
    '---\ncanonical_key: preference:verif-style\n---\n# Verif style\n'
  );
  fs.mkdirSync(path.join(memoryRoot, 'entities', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'entities', 'people', 'alice.md'),
    '---\ncanonical_key: person:alice\n---\n# Alice\n'
  );
  fs.writeFileSync(
    path.join(memoryRoot, '.manifest.json'),
    JSON.stringify({ version: 1, files: {} })
  );

  // Excluded directories (should NOT be copied).
  fs.mkdirSync(path.join(memoryRoot, 'rollout_summaries'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'rollout_summaries', 'r1.md'),
    '# r1 summary'
  );
  fs.mkdirSync(path.join(memoryRoot, 'extensions', 'ad_hoc'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'extensions', 'ad_hoc', 'notes.md'),
    '# notes'
  );
}

function setupConfigRoot(configRoot: string): void {
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, 'stage1_policy.md'),
    '# Stage 1 Policy\nFocus on preferences.\n'
  );
  fs.writeFileSync(
    path.join(configRoot, 'memory_layout.json'),
    JSON.stringify({ schema_version: 1, entities: {} })
  );
}

function makeEnv(): StagingTestEnv {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-root-'));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-root-'));
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-root-'));
  setupMemoryRoot(memoryRoot);
  setupConfigRoot(configRoot);
  return {
    stagingRoot,
    memoryRoot,
    configRoot,
    cleanup: () => {
      for (const dir of [stagingRoot, memoryRoot, configRoot]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    },
  };
}

describe('createStaging', () => {
  let env: StagingTestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('1. staging directory structure is correct', async () => {
    const inputs = [
      {
        inputKind: 'rollout' as const,
        inputKey: 'r1',
        contentHash: 'hash-r1',
        sourcePath: path.join(env.memoryRoot, 'rollout_summaries', 'r1.md'),
      },
    ];

    const { stagingDir } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs,
    });

    // Staging dir is stagingRoot/run-1.
    expect(stagingDir).toBe(path.join(env.stagingRoot, 'run-1'));
    expect(fs.existsSync(stagingDir)).toBe(true);

    // Managed memory files copied.
    expect(fs.existsSync(path.join(stagingDir, 'memory', 'items', 'preference', 'verif-style.md'))).toBe(true);
    expect(fs.existsSync(path.join(stagingDir, 'memory', 'entities', 'people', 'alice.md'))).toBe(true);
    expect(fs.existsSync(path.join(stagingDir, 'memory', '.manifest.json'))).toBe(true);

    // Config files copied.
    expect(fs.existsSync(path.join(stagingDir, 'memory-config', 'stage1_policy.md'))).toBe(true);
    expect(fs.existsSync(path.join(stagingDir, 'memory-config', 'memory_layout.json'))).toBe(true);

    // Input files frozen into inputs/rollout/.
    expect(fs.existsSync(path.join(stagingDir, 'inputs', 'rollout', 'r1.md'))).toBe(true);

    // backup/ directory created (empty).
    expect(fs.existsSync(path.join(stagingDir, 'backup'))).toBe(true);

    // Excluded directories NOT copied into staging/memory/.
    expect(fs.existsSync(path.join(stagingDir, 'memory', 'rollout_summaries'))).toBe(false);
    expect(fs.existsSync(path.join(stagingDir, 'memory', 'extensions'))).toBe(false);
  });

  it('2. manifest hash is deterministic — same input → same hash', async () => {
    const inputs1 = [
      {
        inputKind: 'rollout' as const,
        inputKey: 'r1',
        contentHash: 'hash-r1',
        sourcePath: path.join(env.memoryRoot, 'rollout_summaries', 'r1.md'),
      },
    ];
    const inputs2 = [
      {
        inputKind: 'rollout' as const,
        inputKey: 'r1',
        contentHash: 'hash-r1',
        sourcePath: path.join(env.memoryRoot, 'rollout_summaries', 'r1.md'),
      },
    ];

    const r1 = await createStaging(env.stagingRoot, 'run-a', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: inputs1,
    });
    // Clean up first staging so the second run is independent.
    fs.rmSync(r1.stagingDir, { recursive: true, force: true });

    const r2 = await createStaging(env.stagingRoot, 'run-b', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: inputs2,
    });

    // Same memory + config + input content → same manifest hash.
    expect(r1.manifestHash).toBe(r2.manifestHash);
    expect(r1.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('3. symlinks are skipped during copy', async () => {
    // Create a symlink inside memory/entities/people/.
    const symlinkPath = path.join(env.memoryRoot, 'entities', 'people', 'symlink.md');
    fs.symlinkSync(
      path.join(env.memoryRoot, 'items', 'preference', 'verif-style.md'),
      symlinkPath
    );

    const { stagingDir } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: [],
    });

    // Symlink was NOT copied.
    expect(fs.existsSync(path.join(stagingDir, 'memory', 'entities', 'people', 'symlink.md'))).toBe(false);

    // Real file was still copied.
    expect(fs.existsSync(path.join(stagingDir, 'memory', 'entities', 'people', 'alice.md'))).toBe(true);
  });

  it('4. ad_hoc inputs are copied to inputs/ad_hoc/', async () => {
    const adHocFile = path.join(env.memoryRoot, 'extensions', 'ad_hoc', 'notes.md');
    const { stagingDir } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: [
        {
          inputKind: 'ad_hoc' as const,
          inputKey: 'extensions/ad_hoc/notes.md',
          contentHash: 'hash-notes',
          sourcePath: adHocFile,
        },
      ],
    });

    expect(fs.existsSync(path.join(stagingDir, 'inputs', 'ad_hoc', 'notes.md'))).toBe(true);
  });
});

describe('deleteStaging', () => {
  let env: StagingTestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('1. delete removes the entire staging directory', async () => {
    const { stagingDir } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: [],
    });

    expect(fs.existsSync(stagingDir)).toBe(true);

    await deleteStaging(stagingDir);

    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it('2. delete on non-existent directory does not throw', async () => {
    const nonExistent = path.join(env.stagingRoot, 'no-such-run');
    await expect(deleteStaging(nonExistent)).resolves.not.toThrow();
  });
});

describe('validateStagingIntact', () => {
  let env: StagingTestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('1. intact staging — returns true', async () => {
    const { stagingDir, manifestHash } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: [],
    });

    const intact = await validateStagingIntact(stagingDir, manifestHash);
    expect(intact).toBe(true);
  });

  it('2. tampered staging — returns false', async () => {
    const { stagingDir, manifestHash } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: [],
    });

    // Tamper: modify a file.
    fs.appendFileSync(
      path.join(stagingDir, 'memory', 'items', 'preference', 'verif-style.md'),
      '\n# tampered'
    );

    const intact = await validateStagingIntact(stagingDir, manifestHash);
    expect(intact).toBe(false);
  });

  it('3. file added — returns false', async () => {
    const { stagingDir, manifestHash } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: [],
    });

    // Add a new file.
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'preference', 'new.md'),
      '# new file'
    );

    const intact = await validateStagingIntact(stagingDir, manifestHash);
    expect(intact).toBe(false);
  });

  it('4. file deleted — returns false', async () => {
    const { stagingDir, manifestHash } = await createStaging(env.stagingRoot, 'run-1', {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      inputs: [],
    });

    // Delete a file.
    fs.unlinkSync(path.join(stagingDir, 'memory', 'entities', 'people', 'alice.md'));

    const intact = await validateStagingIntact(stagingDir, manifestHash);
    expect(intact).toBe(false);
  });
});