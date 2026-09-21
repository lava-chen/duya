/**
 * Skill-catalog utilities — Plan 560.
 *
 * All prompt text produced by the skills catalog lives in
 * `assets/dynamic/skills-metadata.hbs` (the XML `<available_skills>` block,
 * the optional `### Skill roots` table, and the trailing usage line). This
 * file is pure utilities: description clamping, tier selection, and the
 * per-skill precompute the mapper in `HbsPromptSystem.ts` feeds to the
 * template.
 *
 * Plan 535 / 550 had `formatSkillCatalog(skills)` build the entire body as
 * a single string here; that was deleted in Plan 560 so every prompt-text
 * literal sits under `prompts/assets/` and this file stays utility-only.
 */

import { join } from 'node:path'
import type { PromptSkill } from '../../skills/types.js'
import type { SkillSource } from '../../skills/types.js'
import type { SkillDiagnostic } from '../../skills/diagnostics.js'

/**
 * Per-skill description caps for the catalog listing.
 *
 * Internal skills (`bundled` / `system`) get the wider 250-char cap because
 * the author owns the prose and we trust it to be high-signal for the model.
 * External skills (`user` / `project` / `mcp` / `plugin` / `agent`) get the
 * tighter 120-char cap (matching mcode's `DEFAULT_EXTERNAL_DESCRIPTION_CHARS`
 * in `@mavis/skills/registry.ts:82`) — the description is third-party text
 * that may be padded, so we surface the first line as a one-liner preview.
 *
 * The catalog exists only for discovery — the full SKILL.md is loaded on
 * demand — so verbose descriptions waste first-turn cache_creation tokens
 * without improving match rate.
 */
const INTERNAL_DESCRIPTION_CHARS = 250
const EXTERNAL_DESCRIPTION_CHARS = 120

/**
 * Classify a skill source as external for catalog-budget purposes.
 *
 * Mirrors mcode's `sourceExternal` (`@mavis/skills/registry.ts:728`):
 * anything not built into the agent binary is treated as external so its
 * description gets the tighter 120-char cap.
 *
 *   bundled / system     → internal (250 chars)
 *   user / project /
 *   mcp / plugin / agent → external (120 chars)
 */
export function isSkillSourceExternal(source: SkillSource): boolean {
  return source !== 'bundled' && source !== 'system'
}

function clampDescription(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * First non-empty line of a description (mcode `firstNonEmptyLine` parity).
 * External skill descriptions are third-party text, often multi-line YAML
 * blobs; the catalog surfaces only the first line as a one-liner preview.
 */
function firstNonEmptyLine(value: string): string {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * The description text the catalog renders for a skill.
 *
 *   internal (bundled / system) → full description clamped to 250 chars
 *   external                    → first non-empty line clamped to 120 chars
 *                                 (mcode `firstDescriptionLine || description`
 *                                 + `truncate(..., 120)` parity)
 */
export function displayDescription(skill: PromptSkill): string {
  if (isSkillSourceExternal(skill.source)) {
    const first = firstNonEmptyLine(skill.description);
    return clampDescription(first || skill.description, EXTERNAL_DESCRIPTION_CHARS);
  }
  return clampDescription(skill.description, INTERNAL_DESCRIPTION_CHARS);
}

/** XML-escape a string for use in catalog tags (per `<name>` / `<description>`). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Absolute path to the skill's SKILL.md, when the loader recorded its root. */
export function skillLocation(skill: PromptSkill): string | undefined {
  return skill.skillRoot ? join(skill.skillRoot, 'SKILL.md') : undefined
}

/**
 * Token budget for the whole catalog block.
 *
 * Phase A-2 of plan 535: aligned with mcode's
 * `DEFAULT_RENDER_BUDGET_CHARS = 20_000` (`@mavis/skills/registry.ts:81`).
 * At 4 chars/token the budget is 5000 tokens — enough to render the 22
 * bundled skills at full tier (name + description + location) without
 * dropping to compact.
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
export const DEFAULT_CATALOG_BUDGET_CHARS = 20_000
const DEFAULT_CATALOG_BUDGET_TOKENS = DEFAULT_CATALOG_BUDGET_CHARS / 4
const CATALOG_CHARS_PER_TOKEN = 0.25

export type CatalogTier = 'full' | 'compact' | 'alias-only'

export interface CatalogBudget {
  tokens: number
  charsPerToken: number
}

export const DEFAULT_BUDGET: CatalogBudget = {
  tokens: DEFAULT_CATALOG_BUDGET_TOKENS,
  charsPerToken: CATALOG_CHARS_PER_TOKEN,
}

/**
 * Estimate the rendered catalog's token footprint for a given tier.
 * Used by `pickCatalogTier` to choose the tier that fits the budget.
 *
 * Counts only fields that would be emitted at the given tier — so the same
 * skill list can be re-estimated cheaply as the tier drops.
 *
 * The `fixedOverheadChars` parameter covers the post-XML usage line and the
 * optional `### Skill roots` table; the mapper pre-measures it against the
 * hbs template so the estimate tracks the actual render within ~10%.
 */
export function estimateCatalogChars(
  skills: PromptSkill[],
  tier: CatalogTier,
  fixedOverheadChars: number,
): number {
  let chars = fixedOverheadChars
  for (const skill of skills) {
    chars += skill.name.length + 1
    if (tier === 'full' || tier === 'compact') {
      chars += displayDescription(skill).length + 1
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
export function pickCatalogTier(
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
 * Build the XML-safe per-skill record the .hbs iterates with.
 *
 * `escapeXml` runs here (not in the template) because Handlebars escapes
 * `{{var}}` as HTML, but the catalog renders raw XML where `<` / `>` must
 * be `&lt;` / `&gt;` — and a stray `<` in a skill name would otherwise
 * become a tag.
 *
 * `show_description` / `show_location` are mirrored per-entry (not just at
 * the catalog level) because `{{#each}}` creates a new context — a bare
 * `{{#if show_description}}` inside the loop body would never see the
 * outer var. The mapper in `hbs/HbsPromptSystem.ts` decorates every entry
 * with the same tier-derived booleans so the template can branch on them.
 */
export interface CatalogSkillEntry {
  name: string
  description: string
  location: string | undefined
  /**
   * Tier-derived booleans the .hbs gates `<description>` / `<location>`
   * on. The mapper in `hbs/HbsPromptSystem.ts` fills these once per
   * render (they're constant for every entry in a single catalog).
   * Optional here so `buildCatalogSkillEntry` callers can build a
   * `CatalogSkillEntry` without the tier context and decorate later.
   */
  show_description?: boolean
  show_location?: boolean
}

export function buildCatalogSkillEntry(skill: PromptSkill): CatalogSkillEntry {
  return {
    name: escapeXml(skill.name),
    description: escapeXml(displayDescription(skill)),
    location: skillLocation(skill),
  }
}

/**
 * The fixed overhead `pickCatalogTier` should budget against.
 *
 * Covers the `<available_skills>` wrapper, the trailing usage prose, and
 * the worst-case `### Skill roots` table. Updated when the .hbs body
 * changes — keep these literals byte-identical to the corresponding
 * template lines so the estimate stays accurate.
 */
export const SKILLS_CATALOG_FIXED_OVERHEAD_CHARS =
    '<available_skills>\n</available_skills>'.length
  + '## Available skills\n\n'.length
  + 'Load a skill by reading its <location> with the read tool; the `Skill` tool is a fallback that loads the same instructions by name. This index is not a substitute for the selected skill\'s SKILL.md.'.length
  + '\nThis catalog is the complete, authoritative list of installed skills for this session. When the user asks what skills you have, what you can do, or which skill fits a task, answer directly from it — do not run CLI commands (such as `duya skill list`), enumerate skill directories, or query any other source to re-discover skills. CLI skill commands exist for the user\'s terminal-side management (install / enable / disable), not for your inventory answers.'.length
  + '\n\n### Skill roots\n\nWhen the catalog drops a `<location>` to fit the token budget, look it up here. Reading the path with the read tool is preferred over the `Skill` tool (fallback).\n\n| Skill | Source |\n|---|---|\n'.length

/**
 * Build the load-diagnostics comment line the mapper emits into
 * `load_diagnostics_line`. Returns an empty string when there are no
 * diagnostics so the .hbs `{{#if}}` collapses the comment.
 *
 * Plan 535 A-3: deliberately minimal — a single count with no paths or
 * messages, so third-party skill text can never leak into the prompt.
 * Full detail lives in the agent logs.
 */
export function buildLoadDiagnosticsLine(diagnostics: SkillDiagnostic[] | undefined): string {
  if (!diagnostics || diagnostics.length === 0) return ''
  const errors = diagnostics.filter((d) => d.level === 'error').length
  const warnings = diagnostics.length - errors
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} skill load error(s)`)
  if (warnings > 0) parts.push(`${warnings} skill load warning(s)`)
  return `  <!-- ${parts.join(', ')} occurred while scanning skill directories; some skills may be missing — see agent logs. -->`
}