/**
 * Skill catalog (progressive disclosure level one).
 *
 * Rendered as structured XML like pi's `<available_skills>` block (see
 * `E:\cloned-projects\pi` `packages/coding-agent/src/core/skills.ts`):
 * each skill carries `name` / `description` / `location` (absolute path
 * to SKILL.md) so the model can load it directly with the read tool, or
 * via the `Skill` tool as a fallback. System skills (DUYA itself) sort
 * first so self-configuration / memory skills win the model's attention.
 */

import { join } from 'node:path'
import { getSkillRegistry } from '../../../skills/registry.js'
import type { PromptSkill } from '../../../skills/types.js'
import { TOOL_NAMES } from '../../types.js'
import type { PromptContext } from '../../types.js'

/**
 * Per-skill description cap for the catalog listing (aligned with
 * claude-code-haha's MAX_LISTING_DESC_CHARS). The catalog exists only for
 * discovery — the full SKILL.md is loaded on demand — so verbose descriptions
 * waste first-turn cache_creation tokens without improving match rate.
 */
const MAX_LISTING_DESC_CHARS = 250

/**
 * Token budget for the whole catalog block. Aligned with codex's
 * SkillMetadataBudget (see codex-rs/ext/skills/src/render.rs).
 *
 * Three render tiers, picked per-section by estimated size vs. budget:
 *   full       — every skill has name + description + location
 *   compact    — location stripped (model falls back to ### Skill roots)
 *   alias-only — description + location stripped (short-name only)
 *
 * The char-per-token ratio is a rough conservative estimate (true tiktoken
 * would push ~3.3 chars/token for English); using 0.25 means we err on the
 * side of falling back earlier, which is safer for cache_creation cost.
 */
const DEFAULT_CATALOG_BUDGET_TOKENS = 1500
const CATALOG_CHARS_PER_TOKEN = 0.25

export type CatalogTier = 'full' | 'compact' | 'alias-only'

export interface CatalogBudget {
  tokens: number
  charsPerToken: number
}

const DEFAULT_BUDGET: CatalogBudget = {
  tokens: DEFAULT_CATALOG_BUDGET_TOKENS,
  charsPerToken: CATALOG_CHARS_PER_TOKEN,
}

function clampDescription(value: string): string {
  if (value.length <= MAX_LISTING_DESC_CHARS) return value;
  return `${value.slice(0, MAX_LISTING_DESC_CHARS - 1).trimEnd()}…`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Absolute path to the skill's SKILL.md, when the loader recorded its root. */
function skillLocation(skill: PromptSkill): string | undefined {
  return skill.skillRoot ? join(skill.skillRoot, 'SKILL.md') : undefined
}

/**
 * Estimate the rendered catalog's token footprint for a given tier.
 * Used by `pickCatalogTier` to choose the tier that fits the budget.
 *
 * Counts only fields that would be emitted at the given tier — so the same
 * skill list can be re-estimated cheaply as the tier drops.
 */
function estimateCatalogChars(
  skills: PromptSkill[],
  tier: CatalogTier,
  fixedOverheadChars: number,
): number {
  let chars = fixedOverheadChars
  for (const skill of skills) {
    chars += skill.name.length + 1
    if (tier === 'full' || tier === 'compact') {
      chars += clampDescription(skill.description).length + 1
    }
    if (tier === 'full') {
      const location = skillLocation(skill)
      if (location) chars += location.length + 1
    }
    // Per-skill XML wrapper overhead: opening/closing tags, indent, plus
    // the `<name>...</name>` and optional `<description>...</description>`
    // tag wrapping. Picked empirically so that the actual rendered length
    // tracks the estimate within ~10%.
    chars += 80
  }
  return chars
}

/**
 * Choose the richest tier whose estimated size fits within the budget.
 *
 *   1. Try `full` — if it fits at <= 70% of budget, use it (leaves headroom)
 *   2. Try `compact` — if it fits at <= 100% of budget, use it
 *   3. Fall back to `alias-only` — short names only; the model relies on the
 *      `### Skill roots` table for paths and must load SKILL.md on demand
 */
function pickCatalogTier(
  skills: PromptSkill[],
  budget: CatalogBudget,
  fixedOverheadChars: number,
): CatalogTier {
  const budgetChars = budget.tokens * (1 / budget.charsPerToken)
  const fitsFull = estimateCatalogChars(skills, 'full', fixedOverheadChars)
    <= budgetChars * 0.7
  if (fitsFull) return 'full'
  const fitsCompact = estimateCatalogChars(skills, 'compact', fixedOverheadChars)
    <= budgetChars
  if (fitsCompact) return 'compact'
  return 'alias-only'
}

/**
 * Render the `### Skill roots` alias table. Maps each skill's canonical name
 * to its SKILL.md absolute path so the model can resolve names dropped from
 * the catalog body (alias-only tier) without needing the Skill tool.
 *
 * Aligns with codex's `### Skill roots` block (catalog_prompt.rs:39), but
 * stays inside the pi-style markdown shell instead of a separate `## Skills`
 * section.
 */
function formatSkillRoots(skills: PromptSkill[]): string {
  const sorted = [...skills].sort((left, right) => {
    if (left.source === 'system' && right.source !== 'system') return -1
    if (left.source !== 'system' && right.source === 'system') return 1
    return left.name.localeCompare(right.name)
  })
  const rows: string[] = ['| Skill | Source |', '|---|---|']
  for (const skill of sorted) {
    const location = skillLocation(skill)
    if (!location) continue
    rows.push(`| ${escapeXml(skill.name)} | ${escapeXml(location)} |`)
  }
  if (rows.length === 2) return ''
  return `### Skill roots

When the catalog drops a \`<location>\` to fit the token budget, look it up here. Reading the path with the read tool is preferred over the \`Skill\` tool (fallback).

${rows.join('\n')}`
}

export function formatSkillCatalog(
  skills: PromptSkill[],
  budget: CatalogBudget = DEFAULT_BUDGET,
): string {
  const byName = (list: PromptSkill[]): PromptSkill[] =>
    [...list].sort((left, right) => left.name.localeCompare(right.name))

  // System skills first (they govern DUYA itself), then everything else.
  const systemSkills = byName(skills.filter(s => s.source === 'system'))
  const otherSkills = byName(skills.filter(s => s.source !== 'system'))
  const orderedSkills = [...systemSkills, ...otherSkills]

  // Fixed overhead covers the XML wrapper, the section header, the
  // post-section usage line, and the optional ### Skill roots table.
  // We approximate the latter by always counting its worst-case size and
  // letting tier selection handle the difference.
  const fixedOverhead =
    '<available_skills>\n</available_skills>'.length
    + '## Available skills\n\n'.length
    + 'Load a skill by reading its <location> with the read tool; the `Skill` tool is a fallback that loads the same instructions by name. This index is not a substitute for the selected skill\'s SKILL.md.'.length
    + '\n\n### Skill roots\n\nWhen the catalog drops a `<location>` to fit the token budget, look it up here. Reading the path with the read tool is preferred over the `Skill` tool (fallback).\n\n| Skill | Source |\n|---|---|\n'.length

  const tier = pickCatalogTier(orderedSkills, budget, fixedOverhead)

  const lines: string[] = ['<available_skills>']
  const renderSkill = (skill: PromptSkill, renderTier: CatalogTier): void => {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(skill.name)}</name>`)
    if (renderTier === 'full' || renderTier === 'compact') {
      lines.push(`    <description>${escapeXml(clampDescription(skill.description))}</description>`)
    }
    if (renderTier === 'full') {
      const location = skillLocation(skill)
      if (location) {
        lines.push(`    <location>${escapeXml(location)}</location>`)
      }
    }
    lines.push('  </skill>')
  }
  if (systemSkills.length > 0) {
    lines.push('  <!-- System (DUYA itself) -->')
    for (const skill of systemSkills) {
      renderSkill(skill, tier)
    }
  }
  if (otherSkills.length > 0) {
    lines.push('  <!-- Other skills -->')
    for (const skill of otherSkills) {
      renderSkill(skill, tier)
    }
  }
  lines.push('</available_skills>')

  const roots = formatSkillRoots(orderedSkills)
  const sections = [`## Available skills`, lines.join('\n')]
  if (roots) sections.push(roots)

  return `${sections.join('\n\n')}

Load a skill by reading its <location> with the read tool; the \`Skill\` tool is a fallback that loads the same instructions by name. This index is not a substitute for the selected skill's SKILL.md.`
}

export function getSkillsMetadataSection(context: PromptContext): string | null {
  // The catalog is only useful when the model can actually load a skill:
  // either via the read tool (primary, pi-style) or the Skill tool
  // (fallback). If neither is available, omit the section.
  const canLoad = context.enabledTools.has(TOOL_NAMES.READ)
    || context.enabledTools.has(TOOL_NAMES.SKILL)
  if (!canLoad) return null

  const skills = getSkillRegistry().listModelInvocable()
  return skills.length > 0 ? formatSkillCatalog(skills) : null
}
