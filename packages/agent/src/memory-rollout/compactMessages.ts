/**
 * Chronological, token-budgeted compaction of session messages for the
 * Memory Stage 1 extractor LLM input (Plan 304 Phase A, design v3 D9).
 *
 * Pure function: no I/O, no clock, no randomness. The same input always
 * produces the same CompactedView, so Stage 1 re-extractions are
 * reproducible and the worker can detect source drift via the
 * `sourceUpdatedAt` / `sourceContentHash` fields echoed from the lease
 * snapshot.
 *
 * Correctness contracts:
 *   - Pinned events (first user task, corrections/acknowledgements, the
 *     last two assistant messages) are NEVER evicted by budget
 *     enforcement.
 *   - Repetitive tool runs (same tool_name + same tool_input, compared
 *     by a simple hash) are sampled: only the chronologically first and
 *     last run of each group survive; middle runs are dropped entirely.
 *   - Budget eviction order: non-pinned, non-sample tool runs in reverse
 *     chronological order, then truncation of remaining non-pinned
 *     content. Eviction stops as soon as the estimate fits or only
 *     protected content remains.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MessageEvent {
  message_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_input?: string;
  type?: string;
  source_type?: string;
  seq_index?: number;
  created_at?: number;
  status?: string;
}

export interface CompactedView {
  readonly lines: string[];
  readonly estimatedTokens: number;
  readonly indexByMessageId: ReadonlyMap<string, number>;
  readonly sourceUpdatedAt: number;
  readonly sourceContentHash: string;
  readonly extractedThroughSeq: number | null;
}

export interface CompactOpts {
  budgetTokens?: number;
  sourceUpdatedAt?: number;
  sourceContentHash?: string;
  preserve?: {
    firstUserTask?: boolean;
    corrections?: boolean;
    toolOutputs?: boolean;
    exitCodes?: boolean;
    finalArtifacts?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_TOKENS = 50_000;
const CHARS_PER_TOKEN = 3;
const INPUT_SIGNATURE_CHARS = 200;
const TOOL_OUTPUT_EXCERPT_CHARS = 1024;
const ASSISTANT_CONTENT_LIMIT = 2048;

/** Event types that carry no extractable knowledge and are always dropped. */
const DROPPABLE_TYPES: ReadonlySet<string> = new Set([
  'token_count',
  'turn_context',
  'reasoning',
  'encrypted_content',
  'progress',
]);

/** Correction / acknowledgement prefixes matched against trimmed user content. */
const CORRECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /^(no|don't|stop|wait|incorrect|wrong|not what)/i,
  /^(不|别|不要|停|错|不是|不要这样)/,
  /^(yes|good|correct|right|keep doing that)/i,
];

/** Substring signals that mark a user message as a correction / sequencing cue. */
const CORRECTION_SUBSTRINGS: ReadonlyArray<string> = ['step 1', 'first do', 'then '];

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

type EventKind = 'user' | 'assistant' | 'tool';

interface IndexedEvent {
  readonly event: MessageEvent;
  readonly kind: EventKind;
  pinned: boolean;
  dropped: boolean;
  line: string | null;
  /** True for the first and last survivor of a (tool_name, input-hash) pair. */
  toolSample: boolean;
}

interface PreserveFlags {
  firstUserTask: boolean;
  corrections: boolean;
  toolOutputs: boolean;
  exitCodes: boolean;
  finalArtifacts: boolean;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function compactMessages(
  messages: ReadonlyArray<MessageEvent>,
  opts: CompactOpts = {},
): CompactedView {
  const budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const preserve: PreserveFlags = {
    firstUserTask: opts.preserve?.firstUserTask ?? true,
    corrections: opts.preserve?.corrections ?? true,
    toolOutputs: opts.preserve?.toolOutputs ?? true,
    exitCodes: opts.preserve?.exitCodes ?? true,
    finalArtifacts: opts.preserve?.finalArtifacts ?? true,
  };

  // Step 1: filter out system role and noise event types.
  const filtered = messages.filter(
    (e) => e.role !== 'system' && (e.type == null || !DROPPABLE_TYPES.has(e.type)),
  );

  // Step 2: sort chronologically (stable, deterministic).
  const sorted = [...filtered].sort(compareEvents);

  // Step 3: classify. Unknown roles are dropped but still consumed a
  // sequence position (gaps are intended).
  const indexed: IndexedEvent[] = [];
  for (const event of sorted) {
    const kind = classifyEvent(event);
    if (kind === null) continue;
    indexed.push({ event, kind, pinned: false, dropped: false, line: null, toolSample: false });
  }

  // Step 4: pinned flags.
  applyPins(indexed, preserve);

  // Step 5: tool run dedup (or wholesale drop when disabled).
  if (preserve.toolOutputs) {
    dedupToolMessages(indexed);
  } else {
    for (const e of indexed) {
      if (e.kind === 'tool') e.dropped = true;
    }
  }

  // Step 6: pre-render surviving lines so budget enforcement can measure.
  for (const e of indexed) {
    if (!e.dropped) e.line = renderLine(e, preserve.exitCodes);
  }

  // Step 7: budget enforcement (mutates `dropped` and `line`).
  enforceBudget(indexed, budgetTokens);

  // Final assembly.
  const survivors = indexed.filter((e) => !e.dropped);
  const lines: string[] = [];
  const indexByMessageId = new Map<string, number>();
  let totalChars = 0;
  let extractedThroughSeq: number | null = null;

  for (const s of survivors) {
    const lineIndex = lines.length;
    const line = s.line ?? renderLine(s, preserve.exitCodes);
    lines.push(line);
    totalChars += line.length;
    indexByMessageId.set(s.event.message_id, lineIndex);
    const seq = s.event.seq_index;
    if (seq != null && (extractedThroughSeq === null || seq > extractedThroughSeq)) {
      extractedThroughSeq = seq;
    }
  }

  // Source version tuple: opts echo wins; otherwise derive from input.
  const sourceUpdatedAt = opts.sourceUpdatedAt ?? computeMaxCreatedAt(messages);
  const sourceContentHash = opts.sourceContentHash ?? '';

  return {
    lines,
    estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    indexByMessageId,
    sourceUpdatedAt,
    sourceContentHash,
    extractedThroughSeq,
  };
}

// ---------------------------------------------------------------------------
// Step 2: chronological ordering
// ---------------------------------------------------------------------------

function compareNullableNumber(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const an = a ?? null;
  const bn = b ?? null;
  if (an === null && bn === null) return 0;
  if (an === null) return 1; // nulls last
  if (bn === null) return -1;
  return an - bn;
}

function compareEvents(a: MessageEvent, b: MessageEvent): number {
  return (
    compareNullableNumber(a.seq_index, b.seq_index) ||
    compareNullableNumber(a.created_at, b.created_at) ||
    (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Step 3: classification
// ---------------------------------------------------------------------------

function classifyEvent(e: MessageEvent): EventKind | null {
  if (e.role === 'user') return 'user';
  if (e.role === 'assistant') return 'assistant';
  if (e.role === 'tool') return 'tool';
  return null;
}

// ---------------------------------------------------------------------------
// Step 4: pinned flags
// ---------------------------------------------------------------------------

function applyPins(indexed: IndexedEvent[], preserve: PreserveFlags): void {
  if (preserve.firstUserTask) {
    const first = indexed.find((e) => e.kind === 'user');
    if (first !== undefined) first.pinned = true;
  }
  if (preserve.corrections) {
    for (const e of indexed) {
      if (e.kind === 'user' && isCorrection(e.event.content)) e.pinned = true;
    }
  }
  if (preserve.finalArtifacts) {
    let remaining = 2;
    for (let i = indexed.length - 1; i >= 0 && remaining > 0; i--) {
      if (indexed[i].kind === 'assistant') {
        indexed[i].pinned = true;
        remaining--;
      }
    }
  }
}

function isCorrection(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  const lower = trimmed.toLowerCase();
  for (const sub of CORRECTION_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Step 5: tool run dedup
// ---------------------------------------------------------------------------

/**
 * djb2-variant string hash. Not cryptographic — used only as a dedup key
 * for (tool_name + tool_input) so identical tool calls collapse together.
 */
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function toolGroupKey(event: MessageEvent): string {
  const name = event.tool_name ?? '';
  const input = event.tool_input ?? '';
  return `${name}:${simpleHash(name + input)}`;
}

/**
 * Group tool messages by (tool_name, input-hash). For groups of 3+,
 * keep ONLY the chronologically first and last as protected samples
 * and drop the middle runs entirely. Groups of 1-2 are untouched.
 * All survivors are marked `toolSample=true` so budget enforcement
 * never evicts them.
 */
function dedupToolMessages(indexed: IndexedEvent[]): void {
  const groups = new Map<string, IndexedEvent[]>();
  for (const e of indexed) {
    if (e.kind !== 'tool' || e.dropped) continue;
    const key = toolGroupKey(e.event);
    const group = groups.get(key);
    if (group !== undefined) {
      group.push(e);
    } else {
      groups.set(key, [e]);
    }
  }
  for (const group of groups.values()) {
    if (group.length < 3) {
      // Every member is a protected sample (first or last trivially).
      for (const e of group) e.toolSample = true;
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      if (i === 0 || i === group.length - 1) {
        group[i].toolSample = true;
      } else {
        group[i].dropped = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: rendering
// ---------------------------------------------------------------------------

function collapseNewlines(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function seqSegment(event: MessageEvent): string {
  return event.seq_index != null ? ` seq=${event.seq_index}` : '';
}

function renderLine(e: IndexedEvent, keepExitCodes: boolean): string {
  const { event, kind } = e;
  const seq = seqSegment(event);
  const outputLimit = keepExitCodes ? TOOL_OUTPUT_EXCERPT_CHARS : TOOL_OUTPUT_EXCERPT_CHARS;
  switch (kind) {
    case 'user':
      return `[user ${event.message_id}${seq}] ${collapseNewlines(event.content)}`;
    case 'assistant':
      return (
        `[assistant ${event.message_id}${seq}] ` +
        truncate(collapseNewlines(event.content), ASSISTANT_CONTENT_LIMIT)
      );
    case 'tool': {
      const callId = event.tool_call_id ?? 'unknown';
      const name = event.tool_name ?? 'unknown';
      const inputSig = truncate(collapseNewlines(event.tool_input ?? ''), INPUT_SIGNATURE_CHARS);
      const outputExcerpt = truncate(collapseNewlines(event.content ?? ''), outputLimit);
      return `[tool ${callId} ${name}${seq}] ${inputSig} => ${outputExcerpt}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Step 7: budget enforcement
// ---------------------------------------------------------------------------

function estimateTokens(indexed: IndexedEvent[]): number {
  let totalChars = 0;
  for (const e of indexed) {
    if (!e.dropped && e.line !== null) totalChars += e.line.length;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Phase 1: drop non-pinned, non-sample tool messages in reverse
 * chronological order. After dedup, all surviving tool messages are
 * protected samples, so this phase is typically a no-op — kept for
 * spec compliance and defensive safety.
 *
 * Phase 2: truncate remaining non-pinned lines (middle content) to
 * fit within the budget. Pinned lines (corrections, first user task,
 * last 2 assistant) are never truncated.
 */
function enforceBudget(indexed: IndexedEvent[], budgetTokens: number): void {
  // Phase 1: drop droppable tool runs.
  while (estimateTokens(indexed) > budgetTokens) {
    let victim: IndexedEvent | null = null;
    for (let i = indexed.length - 1; i >= 0; i--) {
      const e = indexed[i];
      if (e.dropped || e.pinned) continue;
      if (e.kind !== 'tool') continue;
      if (e.toolSample) continue;
      victim = e;
      break;
    }
    if (victim === null) break;
    victim.dropped = true;
  }

  // Phase 2: truncate non-pinned lines to fit.
  const targetChars = budgetTokens * CHARS_PER_TOKEN;
  let totalChars = 0;
  for (const e of indexed) {
    if (!e.dropped && e.line !== null) totalChars += e.line.length;
  }
  if (totalChars <= targetChars) return;

  let excess = totalChars - targetChars;
  for (let i = indexed.length - 1; i >= 0 && excess > 0; i--) {
    const e = indexed[i];
    if (e.dropped || e.pinned || e.line === null) continue;
    const available = e.line.length;
    const toRemove = Math.min(available, excess);
    e.line = e.line.slice(0, available - toRemove);
    excess -= toRemove;
  }
}

// ---------------------------------------------------------------------------
// Source version helpers
// ---------------------------------------------------------------------------

function computeMaxCreatedAt(messages: ReadonlyArray<MessageEvent>): number {
  let max = 0;
  for (const m of messages) {
    if (m.created_at != null && m.created_at > max) max = m.created_at;
  }
  return max;
}
