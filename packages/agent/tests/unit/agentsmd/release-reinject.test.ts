/**
 * Plan 567 §C — one-shot nested AGENTS.md reminder release after compaction.
 *
 * Compaction drops the injected one-shot user-role reminder messages from
 * history. `releaseNestedMemoryForReinject` clears the session-level loaded
 * set so the next trigger-path hit re-injects the dropped reminders, with a
 * cwd guard so a compaction in one project cannot release another project's
 * set (the manager is a process-wide singleton).
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgentsMdManager } from '../../../src/agentsmd/manager.js';

const tmpRoots: string[] = [];

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-567-release-'));
  tmpRoots.push(repo);
  fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'pkg', 'AGENTS.md'), 'Use barrels sparingly.\n', 'utf-8');
  fs.writeFileSync(path.join(repo, 'pkg', 'a.ts'), 'export {};\n', 'utf-8');
  return repo;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('releaseNestedMemoryForReinject (plan 567 §C)', () => {
  it('re-injects a previously injected nested file after release', async () => {
    const repo = makeRepo();
    const trigger = path.join(repo, 'pkg', 'a.ts');
    const manager = createAgentsMdManager();
    await manager.refreshForTask(repo);

    // First trigger: injected, marked loaded.
    const first = await manager.collectNestedMemory([trigger]);
    expect(first).toHaveLength(1);
    // Delta semantics: same trigger injects nothing again.
    expect(await manager.collectNestedMemory([trigger])).toHaveLength(0);

    // Compaction dropped the reminder → release the loaded set.
    expect(manager.releaseNestedMemoryForReinject(repo)).toBeGreaterThan(0);

    // The same trigger re-injects the dropped reminder.
    const second = await manager.collectNestedMemory([trigger]);
    expect(second).toHaveLength(1);
    expect(second[0].path).toBe(path.join(repo, 'pkg', 'AGENTS.md'));
  });

  it('declines a release from a different project cwd (singleton guard)', async () => {
    const repo = makeRepo();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-567-other-'));
    tmpRoots.push(other);
    const trigger = path.join(repo, 'pkg', 'a.ts');
    const manager = createAgentsMdManager();
    await manager.refreshForTask(repo);

    expect(await manager.collectNestedMemory([trigger])).toHaveLength(1);

    // A compaction in another project must not release this project's set.
    expect(manager.releaseNestedMemoryForReinject(other)).toBe(0);
    expect(await manager.collectNestedMemory([trigger])).toHaveLength(0);

    // Same-project release still works afterwards.
    expect(manager.releaseNestedMemoryForReinject(repo)).toBe(1);
  });

  it('returns 0 before initialization', () => {
    const manager = createAgentsMdManager();
    expect(manager.releaseNestedMemoryForReinject()).toBe(0);
  });
});
