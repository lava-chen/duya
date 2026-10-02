import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  resolveAreaPath,
  applyCurationActions,
  cleanStagingTmps,
} from '../curation_file_writer';
import type { CurationAction } from '../curation_response_parser';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cur-writer-'));
}

function writeArea(root: string, areaPath: string, body: string): void {
  const absolute = path.join(root, areaPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body, 'utf8');
}

function readArea(root: string, areaPath: string): string {
  return fs.readFileSync(path.join(root, areaPath), 'utf8');
}

describe('resolveAreaPath', () => {
  const root = '/tmp/memory';

  it('1. resolves a valid areas path', () => {
    expect(resolveAreaPath(root, 'global/areas/foo.md')).toBe(
      path.resolve('/tmp/memory/global/areas/foo.md'),
    );
  });

  it('2. resolves a valid people path', () => {
    expect(resolveAreaPath(root, 'global/people/jane.md')).toBe(
      path.resolve('/tmp/memory/global/people/jane.md'),
    );
  });

  it('3. rejects path with `..`', () => {
    expect(() => resolveAreaPath(root, 'global/areas/../../../etc/passwd'))
      .toThrow(/path traversal/);
  });

  it('4. rejects absolute path', () => {
    expect(() => resolveAreaPath(root, '/etc/passwd'))
      .toThrow(/must start with 'global\/'/);
  });

  it('5. rejects rollout_summaries (not under global/)', () => {
    expect(() => resolveAreaPath(root, 'rollout_summaries/r-1.md'))
      .toThrow(/must start with 'global\/'/);
  });

  it('6. rejects .tmp suffix', () => {
    expect(() => resolveAreaPath(root, 'global/areas/foo.md.tmp'))
      .toThrow(/\.tmp/);
  });
});

describe('applyCurationActions — append', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('7. appends to an existing file', async () => {
    writeArea(root, 'global/areas/foo.md', '# foo\n\nexisting body\n');
    const actions: CurationAction[] = [
      { op: 'append', area_path: 'global/areas/foo.md', content: '## rule\n- never lie', reason: 'r-1' },
    ];
    const result = await applyCurationActions(root, actions);
    expect(result.applied).toBe(1);
    expect(result.errors).toEqual([]);
    const body = readArea(root, 'global/areas/foo.md');
    expect(body).toContain('existing body');
    expect(body).toContain('## rule');
    expect(body).toContain('- never lie');
    // Trailing newlines normalized
    expect(body.endsWith('\n')).toBe(true);
  });

  it('8. appends to a non-existing file', async () => {
    const actions: CurationAction[] = [
      { op: 'append', area_path: 'global/areas/new.md', content: '## fresh\n- claim', reason: 'r-1' },
    ];
    const result = await applyCurationActions(root, actions);
    expect(result.applied).toBe(1);
    expect(readArea(root, 'global/areas/new.md')).toContain('## fresh');
  });

  it('9. two appends in sequence', async () => {
    const actions: CurationAction[] = [
      { op: 'append', area_path: 'global/areas/foo.md', content: '## a\n- 1', reason: 'r-1' },
      { op: 'append', area_path: 'global/areas/foo.md', content: '## b\n- 2', reason: 'r-2' },
    ];
    const result = await applyCurationActions(root, actions);
    expect(result.applied).toBe(2);
    const body = readArea(root, 'global/areas/foo.md');
    expect(body).toMatch(/## a[\s\S]*## b/);
  });
});

describe('applyCurationActions — replace', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('10. overwrites the file atomically', async () => {
    writeArea(root, 'global/areas/foo.md', '# old content\n- obsolete');
    const actions: CurationAction[] = [
      { op: 'replace', area_path: 'global/areas/foo.md', content: '# brand new\n- claim', reason: 'r-1' },
    ];
    const result = await applyCurationActions(root, actions);
    expect(result.applied).toBe(1);
    const body = readArea(root, 'global/areas/foo.md');
    expect(body).not.toContain('obsolete');
    expect(body).toContain('# brand new');
  });

  it('11. no .tmp file left behind', async () => {
    const actions: CurationAction[] = [
      { op: 'replace', area_path: 'global/areas/foo.md', content: '# fresh', reason: 'r-1' },
    ];
    await applyCurationActions(root, actions);
    const leftover = fs.existsSync(path.join(root, 'global/areas/foo.md.tmp'));
    expect(leftover).toBe(false);
  });
});

describe('applyCurationActions — no_op and errors', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('12. no_op does not count toward applied', async () => {
    const actions: CurationAction[] = [
      { op: 'no_op', area_path: 'global/areas/foo.md', content: '', reason: 'r-1' },
    ];
    const result = await applyCurationActions(root, actions);
    expect(result.applied).toBe(0);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(root, 'global/areas/foo.md'))).toBe(false);
  });

  it('13. mixed actions: 1 ok + 1 path-traversal + 1 no_op', async () => {
    const actions: CurationAction[] = [
      { op: 'append', area_path: 'global/areas/foo.md', content: '## claim\n- x', reason: 'r-1' },
      { op: 'append', area_path: '../../etc/passwd', content: 'pwn', reason: 'r-2' },
      { op: 'no_op', area_path: 'global/areas/bar.md', content: '', reason: 'r-3' },
    ];
    const result = await applyCurationActions(root, actions);
    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/must start with 'global\/'/);
  });

  it('14. append to people/ subtree', async () => {
    const actions: CurationAction[] = [
      { op: 'append', area_path: 'global/people/jane.md', content: '- likes tabs', reason: 'r-1' },
    ];
    const result = await applyCurationActions(root, actions);
    expect(result.applied).toBe(1);
    expect(readArea(root, 'global/people/jane.md')).toContain('likes tabs');
  });
});

describe('cleanStagingTmps', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('15. removes stale .tmp files', async () => {
    writeArea(root, 'global/areas/foo.md', '# real');
    writeArea(root, 'global/areas/bar.md.tmp', '# orphan');
    writeArea(root, 'global/areas/nested/baz.md.tmp', '# nested orphan');
    const removed = await cleanStagingTmps(root);
    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(root, 'global/areas/bar.md.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'global/areas/nested/baz.md.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'global/areas/foo.md'))).toBe(true);
  });

  it('16. no .tmp files → 0 removed', async () => {
    writeArea(root, 'global/areas/foo.md', '# real');
    const removed = await cleanStagingTmps(root);
    expect(removed).toBe(0);
  });
});