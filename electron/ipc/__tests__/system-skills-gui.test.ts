/**
 * electron/ipc/__tests__/system-skills-gui.test.ts
 *
 * System-level skills (.system) GUI surfacing (plan 434):
 *  - `.system/<name>/SKILL.md` entries are listed with GUI metadata
 *  - hidden / non-directory / SKILL.md-less / malformed entries are skipped
 *  - system skills are always enabled and never security-scanned
 *  - a missing `.system` directory yields an empty list
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureSystemSkillsSynced,
  listSystemSkillsForGui,
  listSystemSkillNames,
} from '../../skills/system-skills-gui';

const SKILL_MD = `---
name: self-config
description: DUYA self-configuration guide.
when-to-use: Whenever the task reads or writes DUYA's runtime config.
allowed-tools: Read, Write, Edit
---

# Self Config
Instructions body.
`;

describe('system-skills-gui', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-system-skills-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeSkill = (name: string, content: string): string => {
    const dir = path.join(root, '.system', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
    return dir;
  };

  it('lists .system skills with GUI metadata', () => {
    writeSkill('self-config', SKILL_MD);
    writeSkill('memory-search', '---\nname: memory-search\ndescription: RAG memory search.\n---\n\nBody');

    const skills = listSystemSkillsForGui(root);

    expect(skills.map((s) => s.name).sort()).toEqual(['memory-search', 'self-config']);
    const selfConfig = skills.find((s) => s.name === 'self-config')!;
    expect(selfConfig).toMatchObject({
      source: 'system',
      category: 'system',
      enabled: true,
      userInvocable: true,
      security: { verdict: 'safe', findings: [], scanned: false },
    });
    expect(selfConfig.description).toContain('DUYA self-configuration');
    expect(selfConfig.whenToUse).toContain('DUYA');
    expect(selfConfig.allowedTools).toEqual(['Read', 'Write', 'Edit']);
    expect(selfConfig.content).toContain('Instructions body');
    expect(selfConfig.skillRoot).toBe(path.join(root, '.system', 'self-config'));
    expect(fs.existsSync(selfConfig.skillRoot)).toBe(true);
  });

  it('skips hidden dirs, non-directories, and entries without SKILL.md', () => {
    writeSkill('self-config', SKILL_MD);
    fs.mkdirSync(path.join(root, '.system', '.hidden'));
    fs.mkdirSync(path.join(root, '.system', 'no-skill-md'));
    fs.writeFileSync(path.join(root, '.system', 'plain.txt'), 'not a dir', 'utf-8');

    const skills = listSystemSkillsForGui(root);
    expect(skills.map((s) => s.name)).toEqual(['self-config']);
  });

  it('skips malformed SKILL.md (missing description)', () => {
    writeSkill('broken', '---\nname: broken\n---\n\nNo description');
    const skills = listSystemSkillsForGui(root);
    expect(skills).toHaveLength(0);
  });

  it('uses the directory name when frontmatter name is missing', () => {
    writeSkill('fallback-name', '---\ndescription: Some skill.\n---\n\nBody');
    const skills = listSystemSkillsForGui(root);
    expect(skills.map((s) => s.name)).toEqual(['fallback-name']);
  });

  it('listSystemSkillNames returns only names', () => {
    writeSkill('self-config', SKILL_MD);
    writeSkill('memory-search', '---\nname: memory-search\ndescription: RAG memory search.\n---\n\nBody');
    expect(listSystemSkillNames(root).sort()).toEqual(['memory-search', 'self-config']);
  });

  it('returns an empty list when .system does not exist', () => {
    expect(listSystemSkillsForGui(root)).toEqual([]);
    expect(listSystemSkillNames(root)).toEqual([]);
  });

  describe('ensureSystemSkillsSynced', () => {
    let userDir: string;

    beforeEach(() => {
      userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-user-skills-'));
    });

    afterEach(() => {
      fs.rmSync(userDir, { recursive: true, force: true });
    });

    it('copies the bundled .system skills into the user skills dir', () => {
      writeSkill('self-config', SKILL_MD);
      ensureSystemSkillsSynced(userDir, root);

      const copied = path.join(userDir, '.system', 'self-config', 'SKILL.md');
      expect(fs.existsSync(copied)).toBe(true);
      expect(fs.readFileSync(copied, 'utf-8')).toContain('DUYA self-configuration');
    });

    it('never overwrites an existing user copy', () => {
      writeSkill('self-config', SKILL_MD);
      ensureSystemSkillsSynced(userDir, root);
      const userCopy = path.join(userDir, '.system', 'self-config', 'SKILL.md');
      fs.writeFileSync(userCopy, '---\ndescription: user edited\n---\n\nEdited', 'utf-8');

      ensureSystemSkillsSynced(userDir, root);
      expect(fs.readFileSync(userCopy, 'utf-8')).toContain('user edited');
    });

    it('picks up system skills added by a later app update (copy-if-missing)', () => {
      writeSkill('self-config', SKILL_MD);
      ensureSystemSkillsSynced(userDir, root);
      writeSkill('memory-search', '---\nname: memory-search\ndescription: RAG memory search.\n---\n\nBody');

      ensureSystemSkillsSynced(userDir, root);
      expect(fs.existsSync(path.join(userDir, '.system', 'memory-search', 'SKILL.md'))).toBe(true);
    });

    it('is a no-op when the bundled .system dir does not exist', () => {
      const emptyBundled = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-no-system-'));
      ensureSystemSkillsSynced(userDir, emptyBundled);
      expect(fs.existsSync(path.join(userDir, '.system'))).toBe(false);
      fs.rmSync(emptyBundled, { recursive: true, force: true });
    });
  });
});
