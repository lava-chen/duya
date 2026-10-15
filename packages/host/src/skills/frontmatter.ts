/**
 * packages/agent/src/skills/frontmatter.ts
 *
 * Shared SKILL.md / DESCRIPTION.md frontmatter parser.
 *
 * Merges the two historical implementations:
 * - loader.ts `parseFrontmatter` — array splitting for comma-separated
 *   list fields (`allowed-tools`, `arguments`, `paths`).
 * - skillService.ts `parseSkillFrontmatter` — numeric coercion and the
 *   `!key` guard.
 *
 * This is a pure module (no IO, no electron) so it can be imported from
 * both the agent worker and the Electron main / CLI consumers.
 */

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

/** List fields that accept comma-separated values. */
const ARRAY_KEYS = new Set(['allowed-tools', 'arguments', 'paths']);

/**
 * Parse YAML frontmatter from markdown content.
 *
 * Returns `{ frontmatter, content }` where `frontmatter` is a flat
 * key/value map and `content` is the markdown body after the frontmatter.
 * Only handles the simple YAML subset used by SKILL.md files: scalar
 * values, quoted strings, booleans, numbers, and comma-separated arrays
 * for list fields.
 */
export function parseSkillFrontmatter(
  markdown: string,
): { frontmatter: Record<string, unknown>; content: string } {
  const match = markdown.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: {}, content: markdown };
  }

  const frontmatterText = match[1] || '';
  const content = markdown.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};
  const lines = frontmatterText.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: string = line.slice(colonIndex + 1).trim();
    if (!key) continue;

    // Strip surrounding quotes ("..." or '...')
    value = value.replace(/^['"]|['"]$/g, '');

    // Booleans
    if (value === 'true') {
      frontmatter[key] = true;
      continue;
    }
    if (value === 'false') {
      frontmatter[key] = false;
      continue;
    }

    // Integers (e.g. `effort: 4`)
    if (/^\d+$/.test(value)) {
      frontmatter[key] = Number(value);
      continue;
    }

    // Comma-separated arrays for list fields (skips bracketed values so
    // `[a, b]` stays a string — parseAllowedTools normalizes both forms)
    if (
      value.includes(',') &&
      !value.startsWith('[') &&
      ARRAY_KEYS.has(key)
    ) {
      frontmatter[key] = value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      continue;
    }

    frontmatter[key] = value;
  }

  return { frontmatter, content };
}
