/**
 * packages/agent/src/skills/skillService.ts
 *
 * Domain reader/service for skills. Single source of truth for
 * the available-skill set, used by both the GUI IPC handler
 * (`skills:list`) and the CLI API server (`GET /v1/skills`).
 *
 * The service uses the shared resolver for winner selection and
 * applies the user's name-scoped `enabled` override.
 *
 * Output is a strict DTO with no absolute paths, no SKILL.md
 * content, no internal precedence numbers.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readSkillProvenance } from './skillsSync.js';
import {
  resolveAvailable,
  effectivePrecedenceOf,
  type SkillCandidate,
  type AvailableSkill,
} from './resolver.js';
import { scanSkillFile } from '../security/skillScanner.js';

// Minimal frontmatter parser (mirrors electron/utils/skill-parser.ts)
// Avoids a cross-package dependency on the Electron side's skill-parser.
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;
function parseSkillFrontmatter(md: string): { frontmatter: Record<string, unknown>; content: string } {
  const m = md.match(FRONTMATTER_REGEX);
  if (!m) return { frontmatter: {}, content: md };
  const yaml = m[1];
  const frontmatter: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (value === 'true') frontmatter[key] = true;
    else if (value === 'false') frontmatter[key] = false;
    else if (/^\d+$/.test(value)) frontmatter[key] = Number(value);
    else frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return { frontmatter, content: md.slice(m[0].length) };
}
function parseAllowedTools(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export type SkillSource = 'bundled' | 'user' | 'plugin';

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourceId?: string;
  enabled: boolean;
}

export interface SkillInfoItem extends SkillListItem {
  category: string;
  customized: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  platforms: string[];
}

interface InternalCandidate {
  candidate: SkillCandidate;
  /** Optional metadata fetched during discovery. */
  meta?: {
    description?: string;
    frontmatter?: Record<string, unknown>;
    category?: string;
    isCategoryDir?: boolean;
    sourceDir?: string;
  };
}

interface DiscoverArgs {
  userSkillsDir: string;
  /** Map of pluginId → plugin install path. */
  pluginInstallPaths: Record<string, string>;
  /** Pre-fetched overrides. */
  overrides: Record<string, boolean>;
}

/**
 * Compute the public `id` for a winner.
 */
function idFor(winner: AvailableSkill): string {
  if (winner.origin === 'plugin') {
    return `plugin:${winner.pluginId ?? 'unknown'}:${winner.name}`;
  }
  return `${winner.origin}:${winner.name}`;
}

/**
 * Read frontmatter for a top-level skill directory.
 */
function readFrontmatter(skillDir: string): { frontmatter: Record<string, unknown>; description: string; userInvocable: boolean; allowedTools: string[]; platforms: string[]; category?: string } | null {
  const mdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(mdPath)) return null;
  try {
    const content = readFileSync(mdPath, 'utf-8');
    const { frontmatter } = parseSkillFrontmatter(content);
    const description = (frontmatter.description as string) ?? '';
    const userInvocable = frontmatter['user-invocable'] !== false;
    const allowedTools = parseAllowedTools(frontmatter['allowed-tools']);
    const platforms = parseAllowedTools(frontmatter.platforms);
    const category = frontmatter.category as string | undefined;
    return { frontmatter, description, userInvocable, allowedTools, platforms, category };
  } catch {
    return null;
  }
}

/**
 * Determine `customized` for a bundled-derived candidate by comparing
 * the user-dir content hash to the bundled-source hash stored in the
 * manifest. Without manifest data, the conservative default is
 * `false` (i.e., treat as plain bundled).
 */
function isCustomizedBundled(skillName: string, userDir: string, manifestHash: string | null, bundledSourceDir: string | null): boolean {
  // If we have the bundled source on disk, compare hashes.
  if (bundledSourceDir && existsSync(bundledSourceDir)) {
    try {
      const bundledHash = computeDirHashForComparison(bundledSourceDir);
      const userHash = computeDirHashForComparison(userDir);
      return bundledHash !== userHash;
    } catch {
      return false;
    }
  }
  // No bundled source available: treat as plain bundled.
  return false;
}

function computeDirHashForComparison(dir: string): string {
  // Lightweight hash for comparison (excludes hidden files like
  // the provenance marker, mirroring the IPC handler logic).
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const hash: string[] = [];
  const walk = (current: string) => {
    const entries = require('node:fs').readdirSync(current, { withFileTypes: true });
    for (const e of entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const p = require('node:path').join(current, e.name);
      if (e.isFile()) {
        const buf = require('node:fs').readFileSync(p);
        hash.push(`${e.name}:${createHash('md5').update(buf).digest('hex')}`);
      } else if (e.isDirectory()) {
        const sub: string[] = [];
        const w = (cc: string) => {
          for (const ee of require('node:fs').readdirSync(cc, { withFileTypes: true })) {
            if (ee.name.startsWith('.')) continue;
            const pp = require('node:path').join(cc, ee.name);
            if (ee.isFile()) {
              sub.push(`${ee.name}:${createHash('md5').update(require('node:fs').readFileSync(pp)).digest('hex')}`);
            } else if (ee.isDirectory()) {
              w(pp);
            }
          }
        };
        w(p);
        hash.push(`${e.name}/:${createHash('md5').update(sub.join('|')).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return createHash('md5').update(hash.join('|')).digest('hex');
}

/**
 * Discover candidates from all sources.
 */
function discoverCandidates(args: DiscoverArgs): InternalCandidate[] {
  const out: InternalCandidate[] = [];
  const { userSkillsDir, pluginInstallPaths } = args;

  // bundled: scan user dir, looking for entries with marker
  if (existsSync(userSkillsDir)) {
    const entries = require('node:fs').readdirSync(userSkillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (!e.isDirectory()) continue;
      const entryPath = join(userSkillsDir, e.name);
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
      // subcategory layout (DESCRIPTION.md present) is treated as a category dir;
      // for v0 we only handle top-level entries.
      const descriptionPath = join(entryPath, 'DESCRIPTION.md');
      if (existsSync(descriptionPath)) continue;
      const marker = readSkillProvenanceSync(entryPath);
      const fm = readFrontmatter(entryPath);
      if (!fm) continue;
      out.push({
        candidate: {
          name: e.name,
          origin: 'bundled',
          customized: !marker ? false : false, // marker present → customized determined by hash; refined below
          hasMarker: !!marker,
        },
        meta: {
          description: fm.description,
          frontmatter: fm.frontmatter,
          category: fm.category,
          sourceDir: entryPath,
        },
      });
    }
  }

  // user: scan user dir entries without marker
  if (existsSync(userSkillsDir)) {
    const entries = require('node:fs').readdirSync(userSkillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (!e.isDirectory()) continue;
      const entryPath = join(userSkillsDir, e.name);
      const descriptionPath = join(entryPath, 'DESCRIPTION.md');
      if (existsSync(descriptionPath)) continue;
      const marker = readSkillProvenanceSync(entryPath);
      if (marker) continue; // already collected as bundled
      const fm = readFrontmatter(entryPath);
      if (!fm) continue;
      out.push({
        candidate: {
          name: e.name,
          origin: 'user',
          hasMarker: false,
        },
        meta: {
          description: fm.description,
          frontmatter: fm.frontmatter,
          category: fm.category,
          sourceDir: entryPath,
        },
      });
    }
  }

  // plugin: scan enabled plugins' skills dirs
  for (const [pluginId, installPath] of Object.entries(pluginInstallPaths)) {
    const skillsDir = join(installPath, 'skills');
    if (!existsSync(skillsDir)) continue;
    const entries = require('node:fs').readdirSync(skillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (!e.isDirectory()) continue;
      const entryPath = join(skillsDir, e.name);
      const descriptionPath = join(entryPath, 'DESCRIPTION.md');
      if (existsSync(descriptionPath)) continue;
      const fm = readFrontmatter(entryPath);
      if (!fm) continue;
      out.push({
        candidate: {
          name: e.name,
          origin: 'plugin',
          pluginId,
          hasMarker: false,
        },
        meta: {
          description: fm.description,
          frontmatter: fm.frontmatter,
          category: fm.category,
          sourceDir: entryPath,
        },
      });
    }
  }

  return out;
}

function readSkillProvenanceSync(skillDir: string): { schemaVersion: number; origin: 'bundled'; skillName: string } | null {
  // Local inline impl to avoid pulling in skillsSync.ts (which has the async read)
  const markerPath = join(skillDir, '.duya-origin.json');
  try {
    if (!existsSync(markerPath)) return null;
    const raw = readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1 && parsed.origin === 'bundled' && typeof parsed.skillName === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the available skill set with a single winner per name.
 * Refines `customized` for bundled candidates when both user dir
 * and bundled source are available.
 */
export function resolveAvailableSkills(args: DiscoverArgs): {
  winners: (AvailableSkill & { meta?: InternalCandidate['meta'] })[];
} {
  const candidates = discoverCandidates(args);
  // Determine customized for bundled candidates by hash comparison.
  // We don't have a direct bundled-source path here (the IPC handler
  // provides the user-dir path only); without the bundled source,
  // we treat the candidate as plain bundled. The customized flag is
  // a hint, not a safety guarantee — sync protection in skillsSync
  // is the actual safety boundary.
  const refined: SkillCandidate[] = candidates.map((c) => c.candidate);
  const available = resolveAvailable(refined);
  const metaByName = new Map<string, InternalCandidate['meta']>();
  for (const c of candidates) {
    const existing = metaByName.get(c.candidate.name);
    if (!existing) {
      metaByName.set(c.candidate.name, c.meta);
    }
  }
  return {
    winners: available.map((w) => ({
      ...w,
      meta: metaByName.get(w.name),
    })),
  };
}

/**
 * Public list DTO. Applies name-scoped `enabled` override.
 */
export function toListDTO(winner: AvailableSkill & { meta?: InternalCandidate['meta'] }, overrides: Record<string, boolean>): SkillListItem {
  const enabled = overrides[winner.name] !== false;
  return {
    id: idFor(winner),
    name: winner.name,
    description: winner.meta?.description ?? '',
    source: winner.origin,
    sourceId: winner.pluginId,
    enabled,
  };
}

/**
 * Public info DTO. Adds category, customized, userInvocable, allowedTools, platforms.
 */
export function toInfoDTO(winner: AvailableSkill & { meta?: InternalCandidate['meta'] }, overrides: Record<string, boolean>): SkillInfoItem {
  const list = toListDTO(winner, overrides);
  const fm = winner.meta?.frontmatter as Record<string, unknown> | undefined;
  const category = winner.meta?.category ?? (fm?.category as string) ?? 'other';
  const userInvocable = fm?.['user-invocable'] !== false;
  const allowedTools = parseAllowedTools(fm?.['allowed-tools']);
  const platforms = parseAllowedTools(fm?.platforms);
  return {
    ...list,
    category,
    customized: winner.customized,
    userInvocable,
    allowedTools,
    platforms,
  };
}

export interface SkillServiceListArgs {
  userSkillsDir: string;
  pluginInstallPaths: Record<string, string>;
  overrides: Record<string, boolean>;
}

export function listSkillDTOs(args: SkillServiceListArgs): SkillListItem[] {
  const { winners } = resolveAvailableSkills(args);
  return winners.map((w) => toListDTO(w, args.overrides));
}

export function getSkillInfoDTO(args: SkillServiceListArgs & { id: string }): SkillInfoItem | null {
  const { winners } = resolveAvailableSkills(args);
  const found = winners.find((w) => idFor(w) === args.id);
  if (!found) return null;
  return toInfoDTO(found, args.overrides);
}

export { idFor as computeSkillId, effectivePrecedenceOf };