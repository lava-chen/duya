/**
 * packages/agent/src/skills/skillMatch.ts
 *
 * Per-turn skill matching (mcode `matcher(ctx, snapshot)` parity, plan
 * 535 Phase A-4). At the start of each turn the agent's prompt text is
 * matched against installed skills to produce a bounded suggestion
 * reminder — so relevant skills surface even when the user never opened
 * the skill popover.
 *
 * Deliberately conservative matching only:
 *   - 'path': pending conditional skills whose `paths` globs match a
 *     path-like token in the prompt (activates them, same as tool-driven
 *     activation via `activateConditionalSkills`)
 *   - 'name': a whole-word, case-insensitive occurrence of the skill name
 *     in the prompt (min length 3 to avoid noise)
 *
 * Fuzzy description matching (BM25 / n-gram) is plan 535 Phase C and is
 * intentionally NOT here. Fail-closed: hidden, model-invocation-disabled,
 * and disabled skills are never suggested.
 */

import type { PromptSkill } from './types.js';
import { getSkillRegistry } from './registry.js';
import { activateConditionalSkills } from './conditionalSkills.js';

export interface SkillMatchHit {
  skill: PromptSkill;
  reason: 'path' | 'name';
}

export interface SkillMatchOptions {
  /** cwd used to derive relative-path candidates for glob matching. */
  workingDirectory?: string;
  /** Skill names to exclude (e.g. already injected via popover mentions). */
  exclude?: ReadonlySet<string>;
  /** Maximum suggestions in the reminder (default 5). */
  maxSuggestions?: number;
}

export interface SkillMatchSuggestion {
  envelope: string;
  body: string;
}

/** Minimum skill-name length for plain-text name matching. */
const MIN_NAME_MATCH_CHARS = 3;
const DEFAULT_MAX_SUGGESTIONS = 5;
const MAX_DESCRIPTION_CHARS = 100;

/**
 * Extract path-like tokens from free text: anything containing a path
 * separator or ending in a short file extension. Quotes and trailing
 * punctuation are stripped.
 */
export function extractPathLikeTokens(text: string): string[] {
  const tokens = text.split(/\s+/);
  const out: string[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/^["'`(\[{]+/, '').replace(/[)"'\]},.;:!?]+$/, '');
    if (!token) continue;
    if (/[\\/]/.test(token) || /\.[A-Za-z0-9]{1,10}$/.test(token)) {
      out.push(token);
    }
  }
  return out;
}

/**
 * All whitespace-separated tokens with surrounding quotes and trailing
 * punctuation stripped, deduplicated.
 *
 * Unlike `extractPathLikeTokens` (strict path-shaped tokens only), this
 * superset also includes bare filenames like `Dockerfile` — conditional
 * skills conventionally declare bare-filename globs (`Dockerfile*`), and
 * the glob matcher safely rejects tokens that match nothing.
 */
function cleanPromptTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^["'`(\[{]+/, '').replace(/[)"'\]},.;:!?]+$/, '');
    if (token) out.add(token);
  }
  return Array.from(out);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function promptMentionsName(promptText: string, name: string): boolean {
  if (name.length < MIN_NAME_MATCH_CHARS) return false;
  const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`, 'i');
  return re.test(promptText);
}

/**
 * Match the turn's prompt text against installed skills.
 *
 * Side effect: a conditional skill whose `paths` globs match is activated
 * (via `activateConditionalSkills`), consistent with tool-driven
 * activation — activation and suggestion go together.
 */
export function matchSkillsForPrompt(
  promptText: string,
  options: SkillMatchOptions = {},
): SkillMatchHit[] {
  const trimmed = promptText.trim();
  if (!trimmed) return [];

  const exclude = options.exclude ?? new Set<string>();
  const max = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
  const registry = getSkillRegistry();
  const hits: SkillMatchHit[] = [];
  const seen = new Set<string>();

  // 1. Glob matching → activates pending conditional skills whose `paths`
  //    globs match any prompt token. All cleaned tokens are candidates (not
  //    just path-shaped ones) so bare-filename globs like `Dockerfile*`
  //    match; non-matching tokens are rejected by the globs themselves.
  const tokens = cleanPromptTokens(trimmed);
  if (tokens.length > 0) {
    const activatedNames = activateConditionalSkills(tokens, options.workingDirectory);
    for (const name of activatedNames) {
      if (exclude.has(name) || seen.has(name)) continue;
      const skill = registry.get(name);
      if (!skill) continue;
      hits.push({ skill, reason: 'path' });
      seen.add(name);
      if (hits.length >= max) return hits;
    }
  }

  // 2. Name matching over model-invocable skills (fail-closed set: the
  //    registry already filters hidden / disabled / conditional-pending /
  //    model-invocation-disabled entries).
  for (const skill of registry.listModelInvocable()) {
    if (exclude.has(skill.name) || seen.has(skill.name)) continue;
    if (promptMentionsName(trimmed, skill.name)) {
      hits.push({ skill, reason: 'name' });
      seen.add(skill.name);
      if (hits.length >= max) return hits;
    }
  }

  return hits;
}

function clampSuggestionDescription(value: string): string {
  const oneLine = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
  if (oneLine.length <= MAX_DESCRIPTION_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/**
 * Build the per-turn `<skill-suggestion>` injection from match hits.
 * Returns null when nothing matched — no empty envelopes in the prompt.
 */
export function buildSkillSuggestionInjection(hits: SkillMatchHit[]): SkillMatchSuggestion | null {
  if (hits.length === 0) return null;
  const lines = hits.map(({ skill, reason }) => {
    const via = reason === 'path' ? 'file pattern' : 'name';
    const desc = clampSuggestionDescription(skill.description);
    return `- ${skill.name}${desc ? `: ${desc}` : ''} (matched by ${via})`;
  });
  return {
    envelope: 'skill-suggestion',
    body: [
      'These installed skills may help with the current request:',
      ...lines,
      'If one applies, load it with the Skill tool (or read its SKILL.md) before proceeding; if none applies, ignore this reminder.',
    ].join('\n'),
  };
}
