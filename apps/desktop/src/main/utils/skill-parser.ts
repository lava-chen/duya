/**
 * Skill parser utilities extracted from main.ts
 */

export function parseSkillFrontmatter(content: string): { frontmatter: Record<string, unknown>; content: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)---\s*\n?/);

  if (!frontmatterMatch) {
    return { frontmatter: {}, content };
  }

  const frontmatterText = frontmatterMatch[1] || '';
  const markdownContent = content.slice(frontmatterMatch[0].length);

  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterText.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: string = line.slice(colonIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (value === 'true') { frontmatter[key] = true; continue; }
    if (value === 'false') { frontmatter[key] = false; continue; }

    if (value.includes(',') && !value.startsWith('[')) {
      frontmatter[key] = value.split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }

    frontmatter[key] = value;
  }

  return { frontmatter, content: markdownContent };
}

export function parseAllowedTools(tools: unknown): string[] | undefined {
  if (!tools) return undefined;
  if (Array.isArray(tools)) {
    return tools.map(String).filter(Boolean);
  }
  if (typeof tools === 'string') {
    return tools.split(',').map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}
