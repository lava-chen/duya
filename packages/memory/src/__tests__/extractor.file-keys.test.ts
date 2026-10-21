import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { queryExistingKeysFromFiles } from '../extractor.js';

interface FileKeyEnv {
  memoryRoot: string;
  cleanup: () => void;
}

function makeEnv(): FileKeyEnv {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-keys-'));
  return {
    memoryRoot,
    cleanup: () => {
      try { fs.rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function writeCanonical(memoryRoot: string, relPath: string, frontmatter: Record<string, string>, body: string): void {
  const full = path.join(memoryRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(full, `---\n${fm}\n---\n\n${body}`);
}

describe('queryExistingKeysFromFiles', () => {
  let env: FileKeyEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('returns canonical_keys of active files only', async () => {
    writeCanonical(env.memoryRoot, 'items/preference/active.md', {
      memory_id: 'mem_a',
      canonical_key: 'preference:active',
      claim_type: 'preference',
      scope: 'global',
      scope_id: 'null',
      project_id: 'null',
      status: 'active',
      importance: 'normal',
      updated_at: '2026-08-03T12:00:00Z',
    }, 'Active');
    writeCanonical(env.memoryRoot, 'items/preference/old.md', {
      memory_id: 'mem_b',
      canonical_key: 'preference:old',
      claim_type: 'preference',
      scope: 'global',
      scope_id: 'null',
      project_id: 'null',
      status: 'retired',
      importance: 'normal',
      updated_at: '2026-01-01T00:00:00Z',
    }, 'Retired');

    const keys = await queryExistingKeysFromFiles(env.memoryRoot);
    expect(keys).toEqual(['preference:active']);
  });

  it('reads keys from both items/ and entities/', async () => {
    writeCanonical(env.memoryRoot, 'items/fact/a.md', {
      memory_id: 'm1', canonical_key: 'fact:a', claim_type: 'fact', scope: 'global',
      scope_id: 'null', project_id: 'null', status: 'active', importance: 'normal', updated_at: '2026-08-03T00:00:00Z',
    }, 'A');
    writeCanonical(env.memoryRoot, 'entities/people/alice.md', {
      memory_id: 'm2', canonical_key: 'person:alice', claim_type: 'relationship', scope: 'global',
      scope_id: 'null', project_id: 'null', status: 'active', importance: 'normal', updated_at: '2026-08-03T00:00:00Z',
    }, 'Alice');

    const keys = await queryExistingKeysFromFiles(env.memoryRoot);
    expect(keys.sort()).toEqual(['fact:a', 'person:alice']);
  });

  it('returns an empty array when the memory root does not exist', async () => {
    const keys = await queryExistingKeysFromFiles(path.join(env.memoryRoot, 'missing'));
    expect(keys).toEqual([]);
  });

  it('returns an empty array when there are no .md files', async () => {
    fs.mkdirSync(path.join(env.memoryRoot, 'items', 'preference'), { recursive: true });
    const keys = await queryExistingKeysFromFiles(env.memoryRoot);
    expect(keys).toEqual([]);
  });
});