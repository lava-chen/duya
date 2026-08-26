import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { refreshProjections } from '../curation_projection_refresh';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proj-refresh-'));
}

function writeArea(root: string, slug: string, body: string): void {
  const dir = path.join(root, 'global/areas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), body, 'utf8');
}

function writePerson(root: string, slug: string, body: string): void {
  const dir = path.join(root, 'global/people');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), body, 'utf8');
}

function readUtf8(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

describe('refreshProjections', () => {
  let root: string;
  beforeEach(() => { root = mkRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('1. empty memory root → no files written', async () => {
    const touched = await refreshProjections(root);
    expect(touched).toEqual([]);
  });

  it('2. writes MEMORY.md + 2 index.md when area+person exist', async () => {
    writeArea(root, 'foo', '# Foo\n\nfoo body');
    writePerson(root, 'alice', '# Alice\n\nalice bio');

    const touched = await refreshProjections(root);
    expect(touched).toHaveLength(3); // MEMORY.md, areas/index.md, people/index.md

    const memory = readUtf8(path.join(root, 'MEMORY.md'));
    expect(memory).toContain('**area:foo**');
    expect(memory).toContain('**person:alice**');

    // summary.md is now Phase-3 owned; it is NOT written by refreshProjections.
    expect(fs.existsSync(path.join(root, 'summary.md'))).toBe(false);

    const areaIndex = readUtf8(path.join(root, 'global/areas/index.md'));
    expect(areaIndex).toContain('# Areas Index');
    expect(areaIndex).toContain('foo');

    const personIndex = readUtf8(path.join(root, 'global/people/index.md'));
    expect(personIndex).toContain('# People Index');
    expect(personIndex).toContain('alice');
  });

  it('3. only area → only areas/index.md is written (people/ missing)', async () => {
    writeArea(root, 'only-area', '# Only\n\nonly body');
    const touched = await refreshProjections(root);
    expect(touched).toHaveLength(2); // MEMORY.md, areas/index.md — summary.md is Phase-3 owned
    expect(fs.existsSync(path.join(root, 'global/people/index.md'))).toBe(false);
  });

  it('4. cleans stale .tmp files before writing', async () => {
    writeArea(root, 'foo', '# Foo\n\nbody');
    fs.writeFileSync(path.join(root, 'MEMORY.md.tmp'), 'stale');
    fs.writeFileSync(path.join(root, 'global/areas/index.md.tmp'), 'stale');
    await refreshProjections(root);
    expect(fs.existsSync(path.join(root, 'MEMORY.md.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'global/areas/index.md.tmp'))).toBe(false);
  });

  it('5. second refresh reflects updated content', async () => {
    writeArea(root, 'first', '# First\n\nbody');
    await refreshProjections(root);
    expect(readUtf8(path.join(root, 'MEMORY.md'))).toContain('first');

    writeArea(root, 'second', '# Second\n\nbody');
    await refreshProjections(root);
    expect(readUtf8(path.join(root, 'MEMORY.md'))).toContain('second');
    expect(readUtf8(path.join(root, 'MEMORY.md'))).toContain('first');
  });

  it('6. custom category gets MEMORY.md entries + its own index.md', async () => {
    // A curator-proposed category (e.g. `global/lessons/`) must be fully
    // visible in the projections — with the old hard-coded index loop it
    // never received an index.md.
    const lessonsDir = path.join(root, 'global/lessons');
    fs.mkdirSync(lessonsDir, { recursive: true });
    fs.writeFileSync(path.join(lessonsDir, 'calculus-101.md'), '# Calculus 101\n\nbody', 'utf8');

    const touched = await refreshProjections(root);

    const memory = readUtf8(path.join(root, 'MEMORY.md'));
    expect(memory).toContain('## lessons');
    expect(memory).toContain('**lessons:calculus-101**');

    const lessonsIndex = readUtf8(path.join(root, 'global/lessons/index.md'));
    expect(lessonsIndex).toContain('# Lessons Index');
    expect(lessonsIndex).toContain('calculus-101');

    expect(touched.some((p) => p.endsWith('global\\lessons\\index.md') || p.endsWith('global/lessons/index.md'))).toBe(true);
  });
});