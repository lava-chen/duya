import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listMemoryEntriesFromFiles } from '../memory-handlers';

interface ListEnv {
  memoryRoot: string;
  cleanup: () => void;
}

function makeEnv(): ListEnv {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memlist-'));
  return {
    memoryRoot,
    cleanup: () => {
      try { fs.rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function writeCanonical(memoryRoot: string, relPath: string, frontmatter: Record<string, string>): void {
  const full = path.join(memoryRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(full, `---\n${fm}\n---\n\nBody`);
}

describe('listMemoryEntriesFromFiles', () => {
  let env: ListEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('returns active canonical files as MemoryEntry rows', async () => {
    writeCanonical(env.memoryRoot, 'items/preference/active.md', {
      memory_id: 'mem_a',
      canonical_key: 'preference:active',
      claim_type: 'preference',
      scope: 'project',
      scope_id: 'duya',
      project_id: '11111111-1111-1111-1111-111111111111',
      status: 'active',
      importance: 'essential',
      updated_at: '2026-08-03T12:00:00Z',
    });

    const entries = await listMemoryEntriesFromFiles(env.memoryRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].memory_id).toBe('mem_a');
    expect(entries[0].canonical_key).toBe('preference:active');
    expect(entries[0].kind).toBe('preference');
    expect(entries[0].scope).toBe('project');
    expect(entries[0].status).toBe('active');
  });

  it('excludes retired files', async () => {
    writeCanonical(env.memoryRoot, 'items/fact/active.md', {
      memory_id: 'm1', canonical_key: 'fact:active', claim_type: 'fact', scope: 'global',
      scope_id: 'null', project_id: 'null', status: 'active', importance: 'normal', updated_at: '2026-08-03T00:00:00Z',
    });
    writeCanonical(env.memoryRoot, 'items/fact/old.md', {
      memory_id: 'm2', canonical_key: 'fact:old', claim_type: 'fact', scope: 'global',
      scope_id: 'null', project_id: 'null', status: 'retired', importance: 'normal', updated_at: '2026-01-01T00:00:00Z',
    });

    const entries = await listMemoryEntriesFromFiles(env.memoryRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].canonical_key).toBe('fact:active');
  });

  it('returns an empty array when the memory root is missing', async () => {
    const entries = await listMemoryEntriesFromFiles(path.join(env.memoryRoot, 'missing'));
    expect(entries).toEqual([]);
  });
});