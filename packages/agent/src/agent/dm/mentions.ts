/**
 * Agent mention parsing (grok-bot 0.18 port).
 *
 * Ported from grok's `source/host/groups/group-chat.ts`
 * (memberMentionHandles / hasMentionAt / parseGroupMentions) and
 * `source/host/agents/agent-messaging.ts` (buildMentionedAgentsContext),
 * adapted to duya:
 *   - roster entries are { id, name } directory entries (no isGroup yet —
 *     shared rooms land with Plan 478, so the @everyone/@all branch is
 *     intentionally not ported);
 *   - the reachability sentence names SendToAgent (duya's tool name).
 *
 * The mention format is plain text: `@Name` anywhere in the user's message,
 * matched word-bounded (a match inside an ASCII word does not count) against
 * each roster name's handles — the full lowercase name, the name with spaces
 * removed, and its first word. Non-ASCII names (e.g. Chinese bot names) work
 * unchanged: the boundary check only excludes ASCII word characters.
 *
 * Pure over text + roster: no I/O, no config reads.
 */

export interface MentionableAgent {
  id: string;
  name: string;
}

/** Handles an agent's name can be mentioned by (grok memberMentionHandles). */
export function agentMentionHandles(name: string): string[] {
  const lower = name.trim().toLowerCase();
  if (!lower) return [];
  const handles = new Set<string>([lower, lower.replace(/\s+/g, '')]);
  const first = lower.split(/\s+/)[0];
  if (first) handles.add(first);
  return [...handles];
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

/** True when `@handle` occurs in `lower` at an ASCII word boundary. */
function hasMentionAt(lower: string, handle: string): boolean {
  const needle = `@${handle}`;
  for (
    let index = lower.indexOf(needle);
    index >= 0;
    index = lower.indexOf(needle, index + 1)
  ) {
    if (!isWordChar(lower[index - 1]) && !isWordChar(lower[index + needle.length])) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a user message for @mentions of roster agents (grok
 * parseGroupMentions, minus the @everyone/@all group branch). Returns the
 * matched roster entries in roster order, deduplicated.
 */
export function parseAgentMentions(
  text: string,
  roster: readonly MentionableAgent[],
): MentionableAgent[] {
  const lower = text.toLowerCase();
  const mentioned: MentionableAgent[] = [];
  const seen = new Set<string>();
  for (const agent of roster) {
    if (seen.has(agent.id)) continue;
    if (agentMentionHandles(agent.name).some((handle) => hasMentionAt(lower, handle))) {
      mentioned.push(agent);
      seen.add(agent.id);
    }
  }
  return mentioned;
}

/**
 * Build the transient context block injected into the turn when the user
 * @mentioned teammates (grok buildMentionedAgentsContext). The model reads
 * the bracketed note so "@ that agent" style references become actionable
 * SendToAgent targets without guessing ids. Returns null when nothing was
 * mentioned.
 */
export function buildMentionedAgentsContext(
  mentioned: readonly MentionableAgent[],
): string | null {
  if (mentioned.length === 0) return null;
  const lines = [
    '[Agents mentioned in this message — you can reach any of them with SendToAgent using their id:',
  ];
  for (const agent of mentioned) {
    lines.push(`- ${agent.name} (id: ${agent.id})`);
  }
  lines.push(']');
  return lines.join('\n');
}
