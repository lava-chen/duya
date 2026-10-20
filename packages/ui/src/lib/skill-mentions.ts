/**
 * Skill mention rewriting (Plan 450 Phase H).
 *
 * Selecting a skill from the `/` popover inserts `/name` into the composer.
 * Submitted verbatim, that text relies on the model guessing the intent —
 * the legacy "Please use the X skill" path even paraphrased the message into
 * prose (message-input-logic.dispatchBadge). Codex instead treats a skill
 * mention as a structured target (`UserInput::Skill`, `skill://` scheme) and
 * injects the SKILL.md content as a `<skill>` fragment for that turn.
 *
 * This helper rewrites a leading `/name` (or a line-leading one) into a
 * codex-style link `[/name](skill://name)` that the model can resolve, and
 * returns the mentioned skill names for structured transport
 * (`mentionedSkills`). The agent resolves the names against its own skill
 * registry — never trusting paths from the renderer — and loads the real
 * SKILL.md body via `getPromptForCommand` (same source as the Skill tool).
 *
 * Fail-open: names that do not resolve against `availableSkills` pass
 * through untouched (built-in composer commands like `/clear` never reach
 * startStream, and unknown `/words` stay prose).
 */

/** Result of {@link rewriteSkillMentionTokens}. */
export interface SkillMentionRewrite {
  /** Content with leading `/name` tokens replaced by `[/name](skill://name)` links. */
  content: string;
  /** Mentioned skill names (canonical, as given in `availableSkills`), first-seen order. */
  mentionedSkills: string[];
}

export function rewriteSkillMentionTokens(
  content: string,
  availableSkills: Array<{ name: string; aliases?: string[] }>,
): SkillMentionRewrite {
  if (!content || availableSkills.length === 0) {
    return { content, mentionedSkills: [] };
  }

  // name/alias → canonical skill name (lowercased lookup keys).
  const byName = new Map<string, string>();
  for (const skill of availableSkills) {
    if (!skill.name) continue;
    byName.set(skill.name.toLowerCase(), skill.name);
    for (const alias of skill.aliases ?? []) {
      if (alias) byName.set(alias.toLowerCase(), skill.name);
    }
  }
  if (byName.size === 0) {
    return { content, mentionedSkills: [] };
  }

  const seen = new Set<string>();
  const ordered: string[] = [];

  // Two alternatives: an already-rewritten link (kept verbatim, counted only)
  // or a slash command at the start of the content or of a line. The name
  // charset matches the loader's skill naming; the token must be followed by
  // whitespace or end-of-line so `/usr/bin/env` and `/path/to` never match.
  const re = /\[\/([^\]]+)\]\((skill:\/\/[^)\s]+)\)|(^|\n)\/([A-Za-z0-9_-]+)(?=\s|$)/g;
  let out = '';
  let lastIndex = 0;
  for (const match of content.matchAll(re)) {
    const index = match.index ?? 0;
    out += content.slice(lastIndex, index);

    if (match[1] !== undefined && match[2] !== undefined) {
      const canonical = byName.get(match[2].slice('skill://'.length).toLowerCase());
      if (canonical) {
        if (!seen.has(canonical)) {
          seen.add(canonical);
          ordered.push(canonical);
        }
      }
      out += match[0];
    } else {
      const prefix = match[3] ?? '';
      const canonical = byName.get(match[4]!.toLowerCase());
      if (canonical) {
        if (!seen.has(canonical)) {
          seen.add(canonical);
          ordered.push(canonical);
        }
        out += `${prefix}[/${canonical}](skill://${canonical})`;
      } else {
        out += match[0];
      }
    }
    lastIndex = index + match[0].length;
  }
  out += content.slice(lastIndex);

  return { content: out, mentionedSkills: ordered };
}
