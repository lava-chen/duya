/**
 * electron/skills/system-skills-gui.ts
 *
 * System-level skills (`.system`) surfacing for the GUI skills list.
 *
 * Plan 434 (user-directed): the built-in `.system` skills
 * (`memory-search` / `self-config` / `self-knowledge` / `plugin-mcp-builder`)
 * are synced into the user skills directory (`~/.duya/skills/.system/`) so
 * they are ordinary visible files, and the GUI `skills:list` handler reads
 * them from there — visible with full content preview, always enabled, and
 * never toggleable (the agent process still loads them from the bundled
 * directory as `source: 'system'`, see plan 414).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSkillFrontmatter, parseAllowedTools } from '../utils/skill-parser';

export interface SystemSkillGuiInfo {
  name: string;
  skillId: string;
  description: string;
  category: string;
  source: 'system';
  sourceId?: string;
  enabled: boolean;
  userInvocable: boolean;
  whenToUse?: string;
  allowedTools?: string[];
  platforms?: string[];
  content: string;
  updatedAt: string;
  frontmatter: Record<string, unknown>;
  skillRoot: string;
  security: {
    verdict: 'safe';
    findings: [];
    scanned: false;
  };
}

/**
 * Mirror one bundled system skill directory into the user skills
 * directory (`<userSkillsDir>/.system/<name>`).
 *
 * System skills are a read-only display mirror (the agent loads them from
 * the bundled directory; the GUI lists the user-dir copy). Policy:
 *
 * - A missing entry is copied wholesale (first sync).
 * - An existing entry is updated FILE-BY-FILE when the bundled content
 *   changed — so fixes like a co-shipped `memory-rag-lib.mjs` (bug report
 *   2026-08-19 #2) reach existing installs.
 * - `hooks.json` is NEVER overwritten: the skill's SKILL.md instructs the
 *   user to edit its `args[0]` in place, and a bundled template change
 *   must not clobber that edit.
 * - Extra files present in the user copy but gone from bundled are kept
 *   (never delete user files).
 */
function syncSystemSkillDir(src: string, dst: string): void {
  if (!fs.existsSync(dst)) {
    fs.cpSync(src, dst, { recursive: true });
    return;
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      syncSystemSkillDir(srcPath, dstPath);
      continue;
    }
    // hooks.json is user-edited by design (SKILL.md: fix args[0] in place).
    if (entry.name === 'hooks.json' && fs.existsSync(dstPath)) continue;
    if (!fs.existsSync(dstPath)) {
      fs.copyFileSync(srcPath, dstPath);
      continue;
    }
    try {
      const a = fs.readFileSync(srcPath);
      const b = fs.readFileSync(dstPath);
      if (!a.equals(b)) fs.copyFileSync(srcPath, dstPath);
    } catch {
      // Unreadable file — leave the existing copy alone.
    }
  }
}

/**
 * Idempotently copy the bundled `.system` skills into the user skills
 * directory (`<userSkillsDir>/.system/`). Per-entry copy-if-missing for
 * fresh installs; changed bundled files are re-mirrored on existing
 * installs (see `syncSystemSkillDir`), while a user-edited copy is never
 * overwritten wholesale.
 */
export function ensureSystemSkillsSynced(userSkillsDir: string, bundledSkillsDir: string): void {
  const srcDir = path.join(bundledSkillsDir, '.system');
  if (!fs.existsSync(srcDir)) return;

  const dstDir = path.join(userSkillsDir, '.system');
  fs.mkdirSync(dstDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const srcEntry = path.join(srcDir, entry.name);
    const dstEntry = path.join(dstDir, entry.name);
    syncSystemSkillDir(srcEntry, dstEntry);
  }
}

/** Resolve `<skillsRoot>/.system` and return the names of valid system skills. */
export function listSystemSkillNames(skillsRoot: string): string[] {
  return listSystemSkillsForGui(skillsRoot).map((skill) => skill.name);
}

/**
 * Scan `<skillsRoot>/.system/<name>/SKILL.md` and return GUI metadata for
 * each valid system skill. Hidden directories, non-directories, and entries
 * without a SKILL.md are skipped. System skills are trusted by design
 * (plan 414 skips their security scan), so `scanned` stays false and the
 * GUI renders them as built-in trusted skills.
 */
export function listSystemSkillsForGui(skillsRoot: string): SystemSkillGuiInfo[] {
  const systemDir = path.join(skillsRoot, '.system');
  if (!fs.existsSync(systemDir)) return [];

  const result: SystemSkillGuiInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(systemDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const skillDir = path.join(systemDir, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const raw = fs.readFileSync(skillMdPath, 'utf-8');
      const { frontmatter, content } = parseSkillFrontmatter(raw);
      const name = (frontmatter.name as string | undefined)?.trim() || entry.name;
      const description = (frontmatter.description as string | undefined)?.trim();
      // Mirror the agent loader: skills without a description are invalid
      // and never registered, so they must not appear in the GUI list.
      if (!description) continue;
      const stat = fs.statSync(skillMdPath);

      result.push({
        name,
        skillId: name,
        description,
        category: 'system',
        source: 'system',
        enabled: true,
        userInvocable: frontmatter['user-invocable'] !== false,
        whenToUse: frontmatter['when-to-use'] as string | undefined,
        allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
        platforms: parseAllowedTools(frontmatter.platforms),
        content,
        updatedAt: stat.mtime.toISOString(),
        frontmatter,
        skillRoot: skillDir,
        security: { verdict: 'safe', findings: [], scanned: false },
      });
    } catch {
      // Skip malformed system skills; the agent loader reports diagnostics.
      continue;
    }
  }

  return result;
}
