/** Small deterministic context assembler for the Host's project-scoped store. */
export interface ProjectContextItem {
  readonly key: string;
  readonly content: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly updatedAt: number;
}

export interface ProjectContextInput {
  readonly projectName: string;
  readonly currentState?: string;
  readonly nextStep?: string;
  readonly decisions: readonly ProjectContextItem[];
  readonly memories: readonly ProjectContextItem[];
  readonly recentActivity?: readonly ProjectContextItem[];
  readonly taskBrief?: string;
  readonly maxCharacters?: number;
}

export function validateProjectMemoryKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(key.trim());
}

export function rankProjectMemory<T extends ProjectContextItem>(items: readonly T[], query = ''): T[] {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return [...items].sort((a, b) => {
    const score = (item: T) => {
      const haystack = `${item.key} ${item.content}`.toLocaleLowerCase();
      return terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0);
    };
    return score(b) - score(a) || b.updatedAt - a.updatedAt;
  });
}

/**
 * Assemble only project facts, accepted decisions, relevant memory and the
 * current task. Conversation transcripts remain in MessageLog and are read by
 * reference; they are never copied into this bounded prompt fragment.
 */
export function assembleProjectContinuityContext(input: ProjectContextInput): string {
  const budget = Math.max(500, Math.min(16_000, input.maxCharacters ?? 8_000));
  const lines = [
    `## Project continuity: ${input.projectName}`,
    'Current project state below comes from durable Host records. Source references identify the supporting message/session/run.',
  ];
  if (input.currentState) lines.push(`### Current state\n${input.currentState}`);
  if (input.nextStep) lines.push(`### Next step\n${input.nextStep}`);
  if (input.decisions.length) {
    lines.push('### Accepted decisions');
    for (const item of input.decisions) lines.push(`- ${item.key}: ${item.content} [source: ${item.sourceType}:${item.sourceId}]`);
  }
  if (input.memories.length) {
    lines.push('### Project memory');
    for (const item of input.memories) lines.push(`- ${item.key}: ${item.content} [source: ${item.sourceType}:${item.sourceId}]`);
  }
  if (input.recentActivity?.length) {
    lines.push('### Recent project activity');
    for (const item of input.recentActivity) lines.push(`- ${item.content} [source: ${item.sourceType}:${item.sourceId}]`);
  }
  if (input.taskBrief) lines.push(`### Current task\n${input.taskBrief}`);
  const full = lines.join('\n\n');
  if (full.length <= budget) return full;
  return `${full.slice(0, budget - 48).trimEnd()}\n\n[Context limited to ${budget} characters.]`;
}
