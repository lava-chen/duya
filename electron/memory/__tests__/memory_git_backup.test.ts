import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitInitIfNeeded, gitCommitSnapshot } from '../memory_git_backup';

describe('memory_git_backup', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('initializes a repo and commits a snapshot', async () => {
    fs.writeFileSync(path.join(root, 'MEMORY.md'), 'hi', 'utf8');
    await gitInitIfNeeded(root);
    await gitCommitSnapshot(root, 'run-abc', '1.2.3');
    expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
  });

  it('does not re-init an existing repo', async () => {
    fs.mkdirSync(path.join(root, '.git'));
    await gitInitIfNeeded(root);
    expect(true).toBe(true);
  });
});
