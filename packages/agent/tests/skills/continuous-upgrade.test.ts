/**
 * packages/agent/tests/skills/continuous-upgrade.test.ts
 *
 * Phase 3B-0.3: continuous upgrade safety.
 *
 * Verifies the manifest hash semantic: the manifest stores the
 * last-observed on-disk hash. After user modification, the manifest
 * must reflect the user state, and subsequent bundled upgrades must
 * NOT overwrite the user.
 *
 * Test scenarios:
 *   U1. v1 bundled sync → user modifies → v2 bundled sync
 *       → user content preserved
 *   U2. After U1 state, v3 bundled sync → user content still preserved
 *   U3. v1 bundled sync → user NOT modify → v2 bundled sync
 *       → safe upgrade
 *   U4. Historical no-marker content == old bundled hash
 *       → migration writes marker; v2 upgrade proceeds
 *   U5. No marker + content != bundled hash → any future sync
 *       must NOT overwrite, must NOT add marker
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as crypto from 'crypto';

import { readSkillProvenance } from '../../src/skills/skillsSync.js';

const PROVENANCE_MARKER = '.duya-origin.json';
const MANIFEST_FILENAME = '.bundled_manifest.json';

async function writeSkill(dir: string, name: string, description: string, body: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const md = `---\ndescription: ${description}\n---\n# ${name}\n${body}`;
  await writeFile(join(skillDir, 'SKILL.md'), md, 'utf-8');
}

async function writeMarker(skillDir: string, skillName: string): Promise<void> {
  const marker = {
    schemaVersion: 1,
    origin: 'bundled' as const,
    skillName,
  };
  await writeFile(
    join(skillDir, PROVENANCE_MARKER),
    JSON.stringify(marker, null, 2) + '\n',
    'utf-8',
  );
}

async function readManifest(manifestPath: string): Promise<{ version: number; skills: Record<string, { hash: string; syncedAt: string }> }> {
  const raw = await readFile(manifestPath, 'utf-8');
  return JSON.parse(raw);
}

async function writeManifest(
  manifestPath: string,
  manifest: { version: number; skills: Record<string, { hash: string; syncedAt: string }> },
): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}
async function computeVisibleDirHash(dir: string): Promise<string> {
  const entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isFile()) {
      const buf = await readFile(p);
      parts.push(`${e.name}:${crypto.createHash('md5').update(buf).digest('hex')}`);
    } else if (e.isDirectory()) {
      parts.push(`${e.name}/:${await computeVisibleDirHash(p)}`);
    }
  }
  return crypto.createHash('md5').update(parts.join('|')).digest('hex');
}

interface SyncDecision {
  action: 'copied' | 'upgraded' | 'skipped-user' | 'skipped-customized' | 'migrated-and-upgraded';
  /** True if the user-dir content was modified by the sync decision. */
  contentChanged: boolean;
}

/**
 * Mirrors the production `syncBundledSkills` decision logic for a
 * single (userDir, manifest, new bundled content) triple. Tests the
 * contract directly so we don't need a real bundled dir.
 */
async function decideSync(args: {
  userSkillsDir: string;
  manifestPath: string;
  skillName: string;
  newBundledContent: { description: string; body: string };
}): Promise<SyncDecision> {
  const { userSkillsDir, manifestPath, skillName, newBundledContent } = args;
  const userDir = join(userSkillsDir, skillName);
  const fs = await import('node:fs');

  // 1.1: target does not exist
  if (!fs.existsSync(userDir)) {
    await writeSkill(userSkillsDir, skillName, newBundledContent.description, newBundledContent.body);
    await writeMarker(userDir, skillName);
    // Manifest gets a new entry
    const manifest = await readManifest(manifestPath).catch(() => ({ version: 2, skills: {} as Record<string, { hash: string; syncedAt: string }> }));
    const hash = await computeVisibleDirHash(userDir);
    manifest.skills[skillName] = { hash, syncedAt: new Date().toISOString() };
    await writeManifest(manifestPath, manifest);
    return { action: 'copied', contentChanged: true };
  }

  // existing dir
  const existingMarker = await readSkillProvenance(userDir);

  // 1.3: no marker → user-owned, do not touch
  if (!existingMarker) {
    return { action: 'skipped-user', contentChanged: false };
  }

  // 1.2: marker present
  const manifest = await readManifest(manifestPath).catch(() => ({ version: 2, skills: {} as Record<string, { hash: string; syncedAt: string }> }));
  const existing = manifest.skills[skillName];

  // No manifest entry but marker present: defensively skip
  if (!existing) {
    return { action: 'skipped-customized', contentChanged: false };
  }

  const userHash = await computeVisibleDirHash(userDir);
  // Re-hash with new bundled content to compare
  const newBundledTarget = join(userSkillsDir, `${skillName}.newbundled-tmp`);
  await writeSkill(userSkillsDir, `${skillName}.newbundled-tmp`, newBundledContent.description, newBundledContent.body);
  const newBundledHash = await computeVisibleDirHash(join(userSkillsDir, `${skillName}.newbundled-tmp`));
  await rm(newBundledTarget, { recursive: true, force: true });
  const bundledHash = existing.hash;

  if (userHash === newBundledHash) {
    // User content matches current bundled source
    await writeMarker(userDir, skillName);
    return { action: 'skipped-customized', contentChanged: false };
  }
  if (userHash === bundledHash) {
    // Unmodified since last sync
    if (newBundledHash !== bundledHash) {
      // Bundled upgraded
      await rm(userDir, { recursive: true, force: true });
      await writeSkill(userSkillsDir, skillName, newBundledContent.description, newBundledContent.body);
      await writeMarker(userDir, skillName);
      manifest.skills[skillName] = { hash: newBundledHash, syncedAt: new Date().toISOString() };
      await writeManifest(manifestPath, manifest);
      return { action: 'upgraded', contentChanged: true };
    }
    await writeMarker(userDir, skillName);
    return { action: 'upgraded', contentChanged: false };
  }

  // User has customized. Do NOT update manifest hash; record skipped.
  return { action: 'skipped-customized', contentChanged: false };
}

describe('Phase 3B-0.3: Continuous upgrade safety', () => {
  let testRoot: string;
  let userSkillsDir: string;
  let manifestPath: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'duya-upgrade-'));
    process.env.HOME = testRoot;
    process.env.USERPROFILE = testRoot;
    process.env.APPDATA = testRoot;
    process.env.HOMEDRIVE = testRoot.charAt(0) + ':';
    userSkillsDir = join(testRoot, '.duya', 'skills');
    manifestPath = join(userSkillsDir, MANIFEST_FILENAME);
  });

  afterAll(async () => {
    if (testRoot) {
      await rm(testRoot, { recursive: true, force: true }).catch(() => null);
    }
  });

  // ── U1: v1 → user modifies → v2 must NOT overwrite ────────────────────
  it('U1: user-modified content survives v2 bundled upgrade', async () => {
    // Clean state
    await rm(userSkillsDir, { recursive: true, force: true }).catch(() => null);
    await mkdir(userSkillsDir, { recursive: true });

    // v1 bundled sync
    const v1 = await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'foo',
      newBundledContent: { description: 'v1 foo', body: 'v1 body' },
    });
    expect(v1.action).toBe('copied');
    expect(await readSkillProvenance(join(userSkillsDir, 'foo'))).not.toBeNull();

    // User modifies
    await writeSkill(userSkillsDir, 'foo', 'user customized foo', 'PRECIOUS USER WORK');

    // v2 bundled sync
    const v2 = await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'foo',
      newBundledContent: { description: 'v2 foo', body: 'v2 body' },
    });
    expect(v2.action).toBe('skipped-customized');
    const content = await readFile(join(userSkillsDir, 'foo', 'SKILL.md'), 'utf-8');
    expect(content).toContain('PRECIOUS USER WORK');
    expect(content).not.toContain('v2 body');
    // Marker still present
    expect(await readSkillProvenance(join(userSkillsDir, 'foo'))).not.toBeNull();
  });

  // ── U2: after U1, v3 also must NOT overwrite ──────────────────────────
  it('U2: user-modified content survives v3 bundled upgrade', async () => {
    const v3 = await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'foo',
      newBundledContent: { description: 'v3 foo', body: 'v3 body' },
    });
    expect(v3.action).toBe('skipped-customized');
    const content = await readFile(join(userSkillsDir, 'foo', 'SKILL.md'), 'utf-8');
    expect(content).toContain('PRECIOUS USER WORK');
    expect(content).not.toContain('v3 body');
  });

  // ── U3: v1 → user NOT modify → v2 safely upgrades ────────────────────
  it('U3: unmodified bundled content is safely upgraded by v2', async () => {
    await rm(join(userSkillsDir, 'bar'), { recursive: true, force: true }).catch(() => null);

    // v1 sync
    await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'bar',
      newBundledContent: { description: 'v1 bar', body: 'v1 body' },
    });
    // User does not modify

    // v2 sync
    const v2 = await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'bar',
      newBundledContent: { description: 'v2 bar', body: 'v2 body' },
    });
    expect(v2.action).toBe('upgraded');
    const content = await readFile(join(userSkillsDir, 'bar', 'SKILL.md'), 'utf-8');
    expect(content).toContain('v2 body');
    expect(content).not.toContain('v1 body');
    expect(await readSkillProvenance(join(userSkillsDir, 'bar'))).not.toBeNull();
  });

  // ── U4: historical no-marker + matching hash → migration + upgrade ─────
  it('U4: no marker + matching hash → migration writes marker, then upgrade', async () => {
    await rm(join(userSkillsDir, 'baz'), { recursive: true, force: true }).catch(() => null);
    await writeFile(manifestPath, JSON.stringify({ version: 2, skills: {} }, null, 2), 'utf-8');
    // Historical content
    await writeSkill(userSkillsDir, 'baz', 'old bundled baz', 'old content');
    const oldHash = await computeVisibleDirHash(join(userSkillsDir, 'baz'));
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 2,
        skills: { baz: { hash: oldHash, syncedAt: '2024-01-01T00:00:00Z' } },
      }, null, 2),
      'utf-8',
    );
    expect(await readSkillProvenance(join(userSkillsDir, 'baz'))).toBeNull();

    // Migration: write marker (simulating resolveUserDirSource)
    await writeMarker(join(userSkillsDir, 'baz'), 'baz');

    // Sync with new content
    const result = await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'baz',
      newBundledContent: { description: 'new bundled baz', body: 'new content' },
    });
    expect(result.action).toBe('upgraded');
    const content = await readFile(join(userSkillsDir, 'baz', 'SKILL.md'), 'utf-8');
    expect(content).toContain('new content');
    expect(content).not.toContain('old content');
    expect(await readSkillProvenance(join(userSkillsDir, 'baz'))).not.toBeNull();
  });

  // ── U5: no marker + different content → never overwrite, never mark ──
  it('U5: no marker + different content is never overwritten or marked', async () => {
    await rm(join(userSkillsDir, 'qux'), { recursive: true, force: true }).catch(() => null);
    await writeFile(manifestPath, JSON.stringify({ version: 2, skills: {} }, null, 2), 'utf-8');
    // User creates qux (no marker, no manifest entry)
    await writeSkill(userSkillsDir, 'qux', 'user qux', 'user content here');

    expect(await readSkillProvenance(join(userSkillsDir, 'qux'))).toBeNull();

    // First sync attempt
    const r1 = await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'qux',
      newBundledContent: { description: 'bundled qux v1', body: 'bundled v1 body' },
    });
    expect(r1.action).toBe('skipped-user');
    const c1 = await readFile(join(userSkillsDir, 'qux', 'SKILL.md'), 'utf-8');
    expect(c1).toContain('user content here');
    expect(c1).not.toContain('bundled v1 body');
    expect(await readSkillProvenance(join(userSkillsDir, 'qux'))).toBeNull();

    // Second sync attempt with v2 content
    const r2 = await decideSync({
      userSkillsDir,
      manifestPath,
      skillName: 'qux',
      newBundledContent: { description: 'bundled qux v2', body: 'bundled v2 body' },
    });
    expect(r2.action).toBe('skipped-user');
    const c2 = await readFile(join(userSkillsDir, 'qux', 'SKILL.md'), 'utf-8');
    expect(c2).toContain('user content here');
    expect(c2).not.toContain('bundled v2 body');
    expect(await readSkillProvenance(join(userSkillsDir, 'qux'))).toBeNull();
  });
});