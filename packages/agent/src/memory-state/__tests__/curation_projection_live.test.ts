import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  generateMemoryMdLive,
  generateSummaryMdLive,
  generateIndexMdLive,
} from '../curation_projection_live';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proj-live-'));
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

describe('generateMemoryMdLive', () => {
  let root: string;
  beforeEach(() => { root = mkRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('1. empty root → empty string', () => {
    expect(generateMemoryMdLive(root)).toBe('');
  });

  it('2. single area file → one ## area section + one line', () => {
    writeArea(root, 'crest-hydrology', '# Cresting Hydrology\n\nA study of crest flow.');
    const md = generateMemoryMdLive(root);
    expect(md).toContain('## area');
    expect(md).toContain('**area:crest-hydrology**');
    expect(md).toContain('A study of crest flow.');
    expect(md).toContain('global/areas/crest-hydrology.md');
  });

  it('3. mixed area + person → two sections, alphabetical claim_type order', () => {
    writeArea(root, 'a-area', '# A Area\n\nbody');
    writePerson(root, 'z-person', '# Z Person\n\nbody');
    const md = generateMemoryMdLive(root);
    const areaIdx = md.indexOf('## area');
    const personIdx = md.indexOf('## person');
    expect(areaIdx).toBeGreaterThan(-1);
    expect(personIdx).toBeGreaterThan(-1);
    expect(areaIdx).toBeLessThan(personIdx);
    expect(md).toContain('**area:a-area**');
    expect(md).toContain('**person:z-person**');
  });

  it('4. skips index.md', () => {
    const dir = path.join(root, 'global/areas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.md'), '# Areas Index\n\njunk');
    writeArea(root, 'real-area', '# Real\n\nbody');
    const md = generateMemoryMdLive(root);
    expect(md).not.toContain('index.md');
    expect(md).toContain('**area:real-area**');
  });

  it('5. truncated output carries the marker', () => {
    for (let i = 0; i < 300; i++) {
      writeArea(root, `item-${String(i).padStart(3, '0')}`,
        `# Item ${i}\n\n${'x'.repeat(2000)}`);
    }
    const md = generateMemoryMdLive(root);
    expect(md.length).toBeLessThanOrEqual(70_000);
    expect(md).toContain('<!-- truncated -->');
  });
});

describe('generateSummaryMdLive', () => {
  let root: string;
  beforeEach(() => { root = mkRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('6. bounded top-N by recency', () => {
    writeArea(root, 'old', '# Old\n\nold body');
    // Make 'new' newer by writing it after
    const newer = path.join(root, 'global/areas/new.md');
    fs.writeFileSync(newer, '# New\n\nnew body');
    // bump newer mtime
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(newer, future, future);

    const md = generateSummaryMdLive(root);
    expect(md).toContain('Memory Summary');
    const newIdx = md.indexOf('[area] new body');
    const oldIdx = md.indexOf('[area] old body');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('7. bounded to 6000 chars', () => {
    for (let i = 0; i < 50; i++) {
      writeArea(root, `area-${i}`, `# Area ${i}\n\n${'y'.repeat(800)}`);
    }
    const md = generateSummaryMdLive(root);
    expect(md.length).toBeLessThanOrEqual(6_500);
  });

  it('8. empty root → empty string', () => {
    expect(generateSummaryMdLive(root)).toBe('');
  });
});

describe('generateIndexMdLive', () => {
  let root: string;
  beforeEach(() => { root = mkRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('9. area index lists every .md except index.md', () => {
    writeArea(root, 'a-one', '# A One\n\nbody');
    writeArea(root, 'a-two', '# A Two\n\nbody');
    const md = generateIndexMdLive(root, 'area');
    expect(md).toContain('# Areas Index');
    expect(md).toContain('a-one');
    expect(md).toContain('a-two');
  });

  it('10. person index lists every person', () => {
    writePerson(root, 'alice', '# Alice\n\nbio');
    const md = generateIndexMdLive(root, 'person');
    expect(md).toContain('# People Index');
    expect(md).toContain('alice');
  });

  it('11. missing directory → empty string', () => {
    expect(generateIndexMdLive(root, 'area')).toBe('');
    expect(generateIndexMdLive(root, 'person')).toBe('');
  });

  it('12. invalid entityType → empty string', () => {
    // @ts-expect-error intentionally wrong type
    expect(generateIndexMdLive(root, 'unknown')).toBe('');
  });
});