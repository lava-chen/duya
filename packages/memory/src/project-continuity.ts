/** Small deterministic context assembler for the Host's project-scoped store. */
export interface ProjectContextItem {
  readonly key: string;
  readonly content: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly updatedAt: number;
  /** Monotonic record version; omitted for append-only activity rows. */
  readonly revision?: number;
  readonly status?: string;
}

export interface ProjectContextInput {
  readonly projectName: string;
  readonly projectId?: string;
  readonly stateRevision?: number;
  readonly stateSourceType?: string;
  readonly stateSourceId?: string;
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

interface SectionBudget {
  readonly min: number;
  readonly max: number;
}

/**
 * Assemble only project facts, accepted decisions, relevant memory and the
 * current task. Conversation transcripts remain in MessageLog and are read by
 * reference; they are never copied into this bounded prompt fragment.
 *
 * The budget is spent in priority order: the current task, current state and
 * next step always survive first; decisions, memory and activity yield.
 * Records carry their source and revision so a later turn can tell which
 * version of a claim it is reading without loading the full history.
 */
export function assembleProjectContinuityContext(input: ProjectContextInput): string {
  const budget = Math.max(500, Math.min(16_000, input.maxCharacters ?? 8_000));
  const stateSource = input.stateSourceType && input.stateSourceId
    ? ` [source: ${input.stateSourceType}:${input.stateSourceId}]`
    : '';
  const stateRevision = input.stateRevision === undefined ? '' : ` (revision ${input.stateRevision})`;

  const sections = [
    {
      heading: '## Project continuity',
      body: `${input.projectName}${input.projectId ? ` (${input.projectId})` : ''}\nSourced durable Host records. Transcripts stay in their Sessions; read them by reference.`,
      budget: { min: 120, max: 320 },
    },
    ...(input.taskBrief ? [{
      heading: '### Current task',
      body: input.taskBrief,
      budget: { min: 300, max: 2400 },
    }] : []),
    ...(input.currentState ? [{
      heading: `### Current state${stateRevision}`,
      body: `${input.currentState}${stateSource}`,
      budget: { min: 200, max: 1600 },
    }] : []),
    ...(input.nextStep ? [{
      heading: '### Next step',
      body: input.nextStep,
      budget: { min: 100, max: 900 },
    }] : []),
  ];
  const listSections: Array<{ heading: string; items: readonly ProjectContextItem[]; budget: SectionBudget }> = [];
  if (input.decisions.length) listSections.push({ heading: '### Accepted decisions', items: input.decisions, budget: { min: 120, max: 2000 } });
  if (input.memories.length) listSections.push({ heading: '### Project memory', items: input.memories, budget: { min: 120, max: 2000 } });
  if (input.recentActivity?.length) listSections.push({ heading: '### Recent project activity', items: input.recentActivity, budget: { min: 80, max: 800 } });

  const parts: string[] = [];
  let remaining = budget;
  let truncated = false;

  const appendFixed = (heading: string, body: string, sectionBudget: SectionBudget): void => {
    const allowed = Math.min(sectionBudget.max, Math.max(sectionBudget.min, remaining));
    if (allowed <= 0) { truncated = true; return; }
    if (allowed > remaining) truncated = true;
    const rendered = `${heading}\n${body}`;
    if (rendered.length <= allowed) {
      parts.push(rendered);
      remaining -= rendered.length + 2;
      return;
    }
    parts.push(`${rendered.slice(0, Math.max(0, allowed - 24)).trimEnd()}\n[section truncated]`);
    remaining = 0;
    truncated = true;
  };

  for (const section of sections) appendFixed(section.heading, section.body, section.budget);

  for (const section of listSections) {
    if (remaining <= 0) { truncated = true; break; }
    const lines = [section.heading];
    let omitted = 0;
    for (const item of section.items) {
      if (remaining <= 0) { omitted += 1; continue; }
      const version = item.revision === undefined ? '' : `rev ${item.revision}${item.status ? `, ${item.status}` : ''}`;
      const line = `- ${item.key}${version ? ` [${version}]` : ''}: ${item.content} [source: ${item.sourceType}:${item.sourceId}]`;
      if (line.length + 1 > Math.min(section.budget.max, remaining)) { omitted += 1; continue; }
      lines.push(line);
      remaining -= line.length + 1;
    }
    if (lines.length > 1) {
      parts.push(lines.join('\n'));
      remaining -= section.heading.length + 2;
    }
    if (omitted > 0) {
      parts.push(`[${omitted} more ${section.heading.replace(/^### /, '').toLowerCase()} record(s) omitted]`);
      truncated = true;
    }
  }

  if (truncated) parts.push(`[Project context limited to ${budget} characters; lower-priority detail is omitted. Read the full record by source reference when needed.]`);
  return parts.join('\n\n').slice(0, budget);
}
