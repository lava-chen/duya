/**
 * What a subagent call IS, read off the tool call that started it.
 *
 * ## Why this is derived from the tool input and not from a run event
 *
 * A subagent is a TOOL CALL in duya: the model invokes `task`, and the call's
 * own arguments already say everything that identifies the child — the name it
 * was given, its type, the model and thinking budget it was asked to use, and
 * the brief. `subagent.started` carries a subset of that (name, type,
 * description) and arrives later; worse, it can be dropped entirely when the
 * frame is emitted after the run that carried the spawn has settled.
 *
 * So the CARD is built from the call, and the lifecycle event is only allowed
 * to refine it (outcome, duration). That ordering is what makes the row correct
 * even when the event stream says nothing at all — a background subagent whose
 * completion lands in a later turn still reads as `running` under the call that
 * started it, which is the truth the transcript can prove.
 *
 * ## Why the effort rides along
 *
 * `model` and `effort` are the two arguments that change what a child COSTS,
 * and they are invisible everywhere else: the parent's footer reports the
 * parent's model. codex puts `(gpt-5 high)` on the spawn row for exactly this
 * reason, and it is the only place a reader can see that one explorer ran at
 * `high` and another at `off`.
 */

/**
 * Model-facing names of the subagent spawn tool.
 *
 * `task` is the current name; `Agent` is the legacy one, kept because a saved
 * transcript replayed through this renderer still carries it.
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'agent']);

/**
 * The type the runtime uses when the model names none.
 *
 * Mirrors `SubagentTool`'s documented default rather than inventing a blank:
 * a subagent row with no role at all reads as an agent of unknown kind, while
 * this one really is a general-purpose agent.
 */
const DEFAULT_AGENT_TYPE = 'general-purpose';

/** True when `name` is the tool that spawns a subagent. */
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.trim().toLowerCase());
}

/** The identity of one subagent, as the call that spawned it declared it. */
export interface SubagentSpec {
  /** The short name the model gave the child, or `''`. */
  readonly name: string;
  /** Agent type, defaulted to `general-purpose` when the call named none. */
  readonly agentType: string;
  /** Requested model, or `''` when the child inherits the parent's. */
  readonly model: string;
  /** Requested thinking budget, or `''` when the child inherits it. */
  readonly effort: string;
  /** One line saying what the child was asked to do. */
  readonly brief: string;
}

/** A non-empty trimmed string, or `''`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The first line of a prompt, for a brief the caller did not write.
 *
 * A subagent spawned without `description` still needs a second row saying what
 * it is doing; the prompt's first non-empty line is the only thing left. It is
 * NOT clipped here — the renderer owns the column budget, and clipping twice
 * would put an ellipsis in the middle of a sentence.
 */
function firstLine(prompt: string): string {
  for (const line of prompt.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/**
 * Read a subagent spec off a tool call, or `null` when this is not one.
 *
 * Accepts the legacy `Agent` name as well as `task`, so an older transcript
 * keeps its card instead of falling back to `Agent(<prompt>)`.
 */
export function readSubagentSpec(toolName: string, input: unknown): SubagentSpec | null {
  if (!isSubagentTool(toolName)) return null;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const prompt = text(record['prompt']);
  const name = text(record['name']);
  const subagentType = text(record['subagent_type']);
  const description = text(record['description']);
  return {
    name,
    agentType: subagentType === '' ? DEFAULT_AGENT_TYPE : subagentType,
    model: text(record['model']),
    effort: text(record['effort']),
    brief: description !== '' ? description : firstLine(prompt),
  };
}

/**
 * The `(model effort)` body for a card: `gpt-5 high`, `high`, `gpt-5`, or `''`.
 *
 * Empty means the call asked for neither, i.e. the child runs on the same model
 * and budget as its parent — and an empty string is what lets the renderer drop
 * the parentheses entirely rather than print `(inherit)`, which would spend six
 * columns saying "nothing was asked for here".
 */
export function subagentBudgetLabel(model: string, effort: string): string {
  return [model, effort].filter((part) => part !== '').join(' ');
}

/**
 * How one subagent's life ended, as far as this process can prove.
 *
 * `unknown` is a real answer: a background child that has not reported back
 * leaves the call settled with a receipt that says `running`, and calling that
 * `completed` would be a claim the transcript cannot back.
 */
export type SubagentOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

/** The lifecycle the card knows, hung off the tool call that spawned it. */
export interface SubagentCard {
  readonly spec: SubagentSpec;
  /** Wall clock at which the call was seen; the only clock this card has. */
  readonly startedAtMs: number;
  /** Protocol subagent id, once `subagent.started` linked itself to this call. */
  subagentId?: string;
  /** Set by `subagent.completed`; absent means "not reported", not "running". */
  outcome?: Exclude<SubagentOutcome, 'running' | 'unknown'>;
  durationMs?: number;
  summary?: string;
}

/**
 * Six characters that tell two unnamed agents apart.
 *
 * A spawn that names no agent is not rare — the model leaves `name` off and the
 * brief is the only thing distinguishing it — and two rows both reading
 * `general-purpose` are a list that cannot be navigated: the user has no way to
 * say which one they mean, and neither has the transcript.
 *
 * The LAST segment is what to take, and it is the same choice codex makes
 * (`thread_label`'s `anonymous`): ids minted in the same breath share their
 * leading timestamp bytes, so a prefix identifies the batch rather than the
 * agent. Six characters of the tail is enough for a session's handful of
 * children and short enough to read at a glance.
 */
export function shortAgentId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === '') return '';
  const tail = trimmed.split(/[-_:]/u).pop() ?? trimmed;
  const compact = tail.replace(/[^0-9a-z]/giu, '');
  return compact.slice(-6);
}

/**
 * The display name of one agent: its nickname, or its role plus a short id.
 *
 * `general-purpose (4f2a1c)` is what an unnamed child reads as. The role stays
 * in front because it is what the agent IS; the id is the disambiguator, so it
 * goes last where it can be ignored when it is not needed.
 */
export function subagentDisplayName(spec: SubagentSpec, id: string): string {
  if (spec.name !== '') return spec.name;
  const suffix = shortAgentId(id);
  return suffix === '' ? spec.agentType : `${spec.agentType} (${suffix})`;
}

/**
 * The three parts of a spawn row, split so each renderer can colour its own.
 *
 * `Robie [explorer] (gpt-5 high)` answers three different questions — who, what
 * kind, what it costs — and every surface that lists an agent has to answer all
 * three identically: the transcript card, the `/subagents` snapshot, and the
 * watch panel. Splitting the parts here is what keeps them from drifting into
 * three spellings of the same agent, which is how a status list stops being
 * usable (a reader cannot match `Robie` against `Robie [explorer]`).
 */
export interface SubagentIdentityParts {
  /** The nickname, or `general-purpose (4f2a1c)` when it has none. */
  readonly name: string;
  /** The role, or `''` — empty when the name IS the role. */
  readonly role: string;
  /** `gpt-5 high`, or `''` when the child inherits both. */
  readonly budget: string;
}

export function subagentIdentityParts(spec: SubagentSpec, id: string): SubagentIdentityParts {
  const budget = subagentBudgetLabel(spec.model, spec.effort);
  return {
    name: subagentDisplayName(spec, id),
    // Only a SEPARATE part when there is a name in front of it: for an unnamed
    // agent the display name already IS the role, and printing both would read
    // `general-purpose (4f2a1c) [general-purpose]`.
    role: spec.name !== '' ? spec.agentType : '',
    budget,
  };
}

/** The parts joined for a surface that has no colour to spend on them. */
export function subagentIdentityText(spec: SubagentSpec, id: string): string {
  const parts = subagentIdentityParts(spec, id);
  return [
    parts.name,
    parts.role === '' ? '' : `[${parts.role}]`,
    parts.budget === '' ? '' : `(${parts.budget})`,
  ].filter((part) => part !== '').join(' ');
}

/**
 * `45s`, `2m 05s`, `1h 03m` — compact enough for one row.
 *
 * Defined here rather than in `background-tasks.ts` because the transcript card
 * and the snapshot both need it and neither should have to import the task
 * MODEL to format a number.
 */
export function formatTaskDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The one-word status a snapshot row prints.
 *
 * `running` is spelled out rather than left implicit: it is the state a reader
 * scans for, and an absent word reads as "finished" in every list.
 */
export function subagentOutcomeLabel(outcome: SubagentOutcome): string {
  switch (outcome) {
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'unknown': return 'no report';
  }
}
