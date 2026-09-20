/**
 * loaderDiagnostics.test.ts
 *
 * Typed skill load diagnostics (plan 535 A-3, mcode `SkillDiagnostic`
 * parity):
 *  - a healthy SKILL.md loads with no diagnostics
 *  - a symlinked SKILL.md is rejected with `skill_symlink_rejected`
 *  - spec violations (name length) collect `name_exceeds_spec`
 *  - a missing SKILL.md stays silent (it drives category recursion)
 *  - the collector + stat identity helpers behave as specified
 *
 * These tests call `loadSkillsFromDirectory` directly (no settings DB,
 * no registry-wide loadSkills pass) so no Electron/better-sqlite3 is
 * touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSkillsFromDirectory } from '../loader.js';
import {
  SkillDiagnosticCollector,
  errorCode,
  sameSkillStat,
} from '../diagnostics.js';
import { resetRootSnapshotCache } from '../rootSnapshotCache.js';

let tempRoot: string;

async function makeSkillDir(name: string, skillMdContent: string): Promise<string> {
  const dir = path.join(tempRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), skillMdContent, 'utf-8');
  return dir;
}

const VALID_SKILL_MD = [
  '---',
  'name: healthy',
  'description: A healthy test skill.',
  '---',
  '',
  '# Healthy',
  '',
  'Body.',
].join('\n');

describe('skill load diagnostics', () => {
  beforeEach(async () => {
    resetRootSnapshotCache();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-skill-diag-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    resetRootSnapshotCache();
  });

  it('loads a healthy skill and collects no diagnostics', async () => {
    await makeSkillDir('healthy', VALID_SKILL_MD);
    const collector = new SkillDiagnosticCollector();

    const skills = await loadSkillsFromDirectory(tempRoot, 'user', undefined, undefined, undefined, true, collector);

    expect(skills.map((s) => s.name)).toContain('healthy');
    expect(collector.takeAll()).toEqual([]);
  });

  it('rejects a symlinked SKILL.md with skill_symlink_rejected', async () => {
    const targetDir = await makeSkillDir('target', VALID_SKILL_MD);
    const linkDir = path.join(tempRoot, 'linked');
    await fs.mkdir(linkDir, { recursive: true });

    // File symlinks on Windows require admin/Developer Mode; skip the
    // assertion when the platform refuses to create one.
    let supported = false;
    try {
      await fs.symlink(path.join(targetDir, 'SKILL.md'), path.join(linkDir, 'SKILL.md'), 'file');
      supported = true;
    } catch {
      supported = false;
    }

    if (!supported) {
      // Still exercise the directory: without the symlink the entry is
      // just an empty dir (no diagnostics, no skills).
      const collector = new SkillDiagnosticCollector();
      const skills = await loadSkillsFromDirectory(tempRoot, 'user', undefined, undefined, undefined, true, collector);
      expect(skills.map((s) => s.name)).not.toContain('linked');
      return;
    }

    const collector = new SkillDiagnosticCollector();
    const skills = await loadSkillsFromDirectory(tempRoot, 'user', undefined, undefined, undefined, true, collector);

    expect(skills.map((s) => s.name)).not.toContain('linked');
    const diags = collector.takeAll();
    const symlinkDiags = diags.filter((d) => d.code === 'skill_symlink_rejected');
    expect(symlinkDiags.length).toBeGreaterThan(0);
    expect(symlinkDiags[0].name).toBe('linked');
    expect(symlinkDiags[0].level).toBe('warning');
  });

  it('collects name_exceeds_spec for an over-long skill directory name', async () => {
    const longName = 'a'.repeat(70); // spec limit is 64
    await makeSkillDir(longName, VALID_SKILL_MD);
    const collector = new SkillDiagnosticCollector();

    const skills = await loadSkillsFromDirectory(tempRoot, 'user', undefined, undefined, undefined, true, collector);

    expect(skills.map((s) => s.name)).toContain(longName);
    const diags = collector.takeAll();
    const specDiags = diags.filter((d) => d.code === 'name_exceeds_spec');
    expect(specDiags.length).toBeGreaterThan(0);
    expect(specDiags[0].level).toBe('warning');
    expect(specDiags[0].name).toBe(longName);
  });

  it('stays silent when a directory has no SKILL.md (category recursion signal)', async () => {
    const emptyDir = path.join(tempRoot, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    const collector = new SkillDiagnosticCollector();

    const skills = await loadSkillsFromDirectory(tempRoot, 'user', undefined, undefined, undefined, true, collector);

    expect(skills).toEqual([]);
    expect(collector.takeAll()).toEqual([]);
  });
});

describe('diagnostics helpers', () => {
  it('errorCode extracts string codes and ignores the rest', () => {
    expect(errorCode({ code: 'ELOOP' })).toBe('ELOOP');
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorCode('nope')).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });

  it('sameSkillStat compares size and mtime only', () => {
    expect(sameSkillStat({ size: 10, mtimeMs: 100 }, { size: 10, mtimeMs: 100 })).toBe(true);
    expect(sameSkillStat({ size: 10, mtimeMs: 100 }, { size: 11, mtimeMs: 100 })).toBe(false);
    expect(sameSkillStat({ size: 10, mtimeMs: 100 }, { size: 10, mtimeMs: 200 })).toBe(false);
  });

  it('collector takeAll resets and caps unbounded collection', () => {
    const collector = new SkillDiagnosticCollector();
    collector.collect({ level: 'error', code: 'skill_read_failed', locationUri: 'x', message: 'm' });
    expect(collector.size).toBe(1);
    expect(collector.takeAll()).toHaveLength(1);
    expect(collector.size).toBe(0);

    for (let i = 0; i < 600; i += 1) {
      collector.collect({ level: 'warning', code: 'name_exceeds_spec', locationUri: 'x', message: 'm' });
    }
    expect(collector.size).toBe(500);
  });
});
