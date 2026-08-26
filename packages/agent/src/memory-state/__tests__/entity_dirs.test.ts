import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  listEntityDirsSync,
  listEntityDirs,
  dirNameToEntityType,
  isValidEntityDirName,
  DEFAULT_ENTITY_TYPES,
} from '../entity_dirs';

/**
 * Entity directory discovery (shared source of truth for MEMORY.md,
 * summary synthesis, curator panorama, and index generation).
 *
 * The critical property under test: custom categories created by the
 * curation protocol's `new_categories` action are discovered alongside
 * the three defaults — a hard-coded consumer list is what stranded them
 * historically.
 */

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entity-dirs-'));
}

function mkdirp(root: string, rel: string): void {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
}

describe('listEntityDirsSync', () => {
  let root: string;
  beforeEach(() => { root = mkRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('missing global/ still returns the three defaults', () => {
    const dirs = listEntityDirsSync(root);
    expect(dirs.map((d) => d.name)).toEqual(['areas', 'people', 'preferences']);
    expect(dirs.map((d) => d.type)).toEqual([...DEFAULT_ENTITY_TYPES]);
    expect(dirs[0].relDir).toBe('global/areas');
  });

  it('discovers a custom category and sorts it after the defaults', () => {
    mkdirp(root, 'global/lessons');
    const dirs = listEntityDirsSync(root);
    expect(dirs.map((d) => d.name)).toEqual(['areas', 'people', 'preferences', 'lessons']);
    expect(dirs[3].type).toBe('lessons');
    expect(dirs[3].relDir).toBe('global/lessons');
  });

  it('multiple customs are alphabetical after the defaults', () => {
    mkdirp(root, 'global/company');
    mkdirp(root, 'global/lessons');
    const names = listEntityDirsSync(root).map((d) => d.name);
    expect(names).toEqual(['areas', 'people', 'preferences', 'company', 'lessons']);
  });

  it('ignores grammar-violating and non-directory entries', () => {
    // NB: avoid names that collide case-insensitively with valid ones
    // (Windows) — on NTFS 'Lessons' IS 'lessons'.
    mkdirp(root, 'global/Bad.Name');   // uppercase + dot → grammar-invalid
    mkdirp(root, 'global/UPPER');      // uppercase → grammar-invalid
    // A FILE whose name matches the grammar must still be skipped.
    fs.writeFileSync(path.join(root, 'global', 'zzfile'), 'not a dir', 'utf8');
    const names = listEntityDirsSync(root).map((d) => d.name);
    expect(names).toEqual(['areas', 'people', 'preferences']);
  });

  it('async variant agrees with the sync variant', async () => {
    mkdirp(root, 'global/lessons');
    const sync = listEntityDirsSync(root);
    const async_ = await listEntityDirs(root);
    expect(async_).toEqual(sync);
  });

  it('duplicate discovery never duplicates defaults', () => {
    mkdirp(root, 'global/areas'); // already a default — must appear once
    const names = listEntityDirsSync(root).map((d) => d.name);
    expect(names.filter((n) => n === 'areas')).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('dirNameToEntityType maps defaults and passes customs through', () => {
    expect(dirNameToEntityType('areas')).toBe('area');
    expect(dirNameToEntityType('people')).toBe('person');
    expect(dirNameToEntityType('preferences')).toBe('preference');
    expect(dirNameToEntityType('lessons')).toBe('lessons');
  });

  it('isValidEntityDirName mirrors the NewCategorySchema grammar', () => {
    expect(isValidEntityDirName('lessons')).toBe(true);
    expect(isValidEntityDirName('company-work')).toBe(true);
    expect(isValidEntityDirName('Lessons')).toBe(false);
    expect(isValidEntityDirName('has.dot')).toBe(false);
    expect(isValidEntityDirName('a')).toBe(false);          // too short
    expect(isValidEntityDirName('a'.repeat(22))).toBe(false); // too long
  });
});
