/**
 * Context-usage estimation — single source of truth (pi parity).
 *
 * One pure function answers "how many tokens does the current context hold":
 * find the latest valid usage anchor (an assistant usage block reported by
 * the provider), add a block-aware estimate of every message appended after
 * it, and fall back to a whole-history estimate + system prefix when no
 * anchor exists. State by design — callers recompute from scratch on every
 * emission; scanning a few hundred messages is microseconds next to LLM
 * latency, and statelessness removes an entire class of boundary bugs.
 *
 * Consumers:
 *  - @duya/agent process entry: emits `chat:token_usage` frames mid-turn.
 *  - renderer bootstrap (useContextUsage): scans persisted messages before
 *    the first worker frame arrives — same function, same numbers.
 *  - compact/tokenBudget.ts: delegates its message estimator here so
 *    compaction and the ring can never disagree about text volume.
 */

// ──────────────────────────────────────────────────────────────────────�────
// Input shapes (structural — both worker Message and renderer Message fit)
// ──────────────────────────────────────────────────────────────────────────

/** Usage block shape: TokenUsage from @duya/ai plus the persisted
 *  turn-cumulative `last_call` sub-block written by the agent process. */
export interface ContextUsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_hit_tokens?: number;
  cache_creation_tokens?: number;
  /** Single-request usage of the final LLM call inside a cumulative block. */
  last_call?: ContextUsageBlock;
}

export interface ContextEstimateMessage {
  role: string;
  content: string | unknown[];
  /** In-memory per-call usage attached by DuyaAgent at push time (pi-style). */
  usage?: ContextUsageBlock | null;
  /** Persisted turn-cumulative usage reloaded from the DB. */
  tokenUsage?: ContextUsageBlock | null;
  stopReason?: string | null;
  /** Compaction boundary marker — anchors at/before it describe the
   *  pre-compaction context and must be ignored. */
  isCompactBoundary?: boolean;
  /** Token-accounting: model that produced this message. Surfaced as
   *  `anchorModel` when this message is the anchor, so consumers can
   *  resolve the context window / pricing against the model that ACTUALLY
   *  processed the last request (a mid-session switch no longer lies). */
  model?: string | null;
}

export interface ContextEstimateOptions {
  /** Estimated system prompt + tool definitions. Added to the headline only
   *  when no usage anchor exists — with an anchor, these values may label
   *  diagnostic composition parts but are never charged a second time. */
  systemPrefixTokens?: number;
  /** Estimated tool-definition surface (name/description/input_schema JSON).
   *  Plan 577 §4: the unanchored fallback historically priced only the
   *  system prefix, so Plugin/MCP-heavy sessions under-counted by the whole
   *  schema volume. Added ONLY on the unanchored path (same double-count
   *  rule as systemPrefixTokens). Diagnostics-only on the anchored path. */
  toolDefinitionsTokens?: number;
}

export interface ContextEstimate {
  /** Full context size. `null` = unknowable right now (post-compaction,
   *  no post-compaction response yet) → UI shows "?" instead of guessing. */
  usedTokens: number | null;
  /** True when driven by a real API usage anchor; false = local estimate. */
  anchored: boolean;
  /** Index of the message providing the anchor, or null. */
  anchorIndex: number | null;
  /** Normalized provider input plus the assistant content actually persisted. */
  anchorTokens: number;
  trailingTokens: number;
  /** Model that produced the anchor request (token-accounting). Null when
   *  unanchored or the anchor predates per-message model attribution. */
  anchorModel: string | null;
  /** Plan 577 §4: the tool-definition volume actually charged to this
   *  estimate (> 0 only on the unanchored path; diagnostics). */
  toolDefinitionsTokens: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** CJK scripts cost ~2.5 chars/token under BPE tokenizers. */
const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;
export const CJK_CHARS_PER_TOKEN = 2.5;
export const ASCII_CHARS_PER_TOKEN = 4;

/** Vision-encoded floor per image block. Pi parity (4800 chars / 4 = 1200);
 *  Anthropic documents ~1.6K tokens for moderate-resolution images, so a
 *  1200 floor matches the real cost closely. Lower floors under-estimate
 *  image-heavy sessions and cause premature compaction. */
export const IMAGE_TOKEN_FLOOR = 1200;

// ──────────────────────────────────────────────────────────────────────────
// Text extraction (block-aware)
// ──────────────────────────────────────────────────────────────────────────

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Extract only the textual payload the model actually pays tokens for:
 * `text.text`, `thinking.thinking`, `tool_use.input` (the argument blob),
 * recursive `tool_result.content`, and an image floor for `image` blocks.
 *
 * Never `JSON.stringify` a whole content array: structural wrappers, escape
 * sequences and key names inflate real prompt volume by 30-50% on tool-heavy
 * sessions while charging nothing on the wire.
 */
function contentBlockText(block: unknown): string {
  if (!block || typeof block === 'string') {
    return typeof block === 'string' ? block : '';
  }
  const b = block as {
    type?: string;
    text?: string;
    thinking?: string;
    input?: unknown;
    content?: unknown;
  };
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' ? b.text : '';
    case 'thinking':
      return typeof b.thinking === 'string' ? b.thinking : '';
    case 'tool_use':
      return b.input !== undefined ? safeStringify(b.input) : '';
    case 'tool_result': {
      if (typeof b.content === 'string') return b.content;
      if (Array.isArray(b.content)) {
        return (b.content as unknown[]).map(contentBlockText).join('');
      }
      return '';
    }
    default:
      // Unknown shape (legacy rows, custom providers): return '' rather than
      // stringify — better an under-report than a 5× over-report.
      return '';
  }
}

/** Language-aware token estimate: CJK ≈ 2.5 chars/token, else ≈ 4 chars/token. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_REGEX) || []).length;
  const otherCount = text.length - cjkCount;
  return (
    Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN) +
    Math.ceil(otherCount / ASCII_CHARS_PER_TOKEN)
  );
}

/** Estimate one message: string content directly, block array via extraction
 *  (image blocks charged at IMAGE_TOKEN_FLOOR each). */
export function estimateMessageTokens(message: {
  role: string;
  content: string | unknown[];
}): number {
  if (typeof message.content === 'string') {
    return estimateTextTokens(message.content);
  }
  let imageCount = 0;
  let chars = 0;
  for (const block of message.content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'image'
    ) {
      imageCount++;
      continue;
    }
    chars += contentBlockText(block).length;
  }
  return Math.ceil(chars / ASCII_CHARS_PER_TOKEN) + imageCount * IMAGE_TOKEN_FLOOR;
}

// ──────────────────────────────────────────────────────────────────────────
// Prompt-volume normalization (cache convention guard)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalize the input-side usage into the prompt volume the model saw.
 *
 * Anthropic reports `input_tokens` EXCLUDING cache read/write; many
 * OpenAI-compatible gateways map `prompt_tokens` (which INCLUDES cached
 * tokens) onto the same field names, so field names alone cannot
 * distinguish the conventions. Heuristic: if any cache counter is strictly
 * larger than raw input, the input cannot already contain it — add all
 * cache tokens back; otherwise assume they are included.
 *
 * Use `>` (not `>=`): the equality boundary is the near-full-cache hit on an
 * OpenAI-compatible gateway where `input_tokens` already includes the cached
 * prefix AND the gateway reports `cache_hit_tokens` separately. There
 * `cache_hit_tokens ≈ input_tokens` (miss→0), so `>=` misfires and reports
 * `input + cacheHit` ≈ 2× the real prompt — the ring reads "over 1M right
 * after a short chat". Strict `>` keeps the inclusive convention correct
 * there while `input=0 / cache>0` still trips the excluded branch (0 < cache).
 * This matches the renderer utils (context-usage-utils.ts normalizeInputTokens
 * / onlyNewInputTokens) and the worker ledger (seed-token-usage.ts
 * normalizeOnlyNewInput), all of which already use `>`.
 *
 * The persisted turn-cumulative blocks carry `last_call` (the final single
 * request); prefer it — the cumulative sum inflates tool-heavy turns ~N×.
 */
export function normalizePromptTokens(
  raw: ContextUsageBlock | null | undefined,
): { prompt: number; output: number } {
  if (!raw) return { prompt: 0, output: 0 };
  const src = raw.last_call ?? raw;
  const input = src.input_tokens || 0;
  const output = src.output_tokens || 0;
  const cacheHit = src.cache_hit_tokens || 0;
  const cacheWrite = src.cache_creation_tokens || 0;
  const prompt =
    cacheHit > input || cacheWrite > input
      ? input + cacheHit + cacheWrite
      : input;
  return { prompt, output };
}

/** True when a usage block reports output but ALL input-side counters are
 *  zero. "Under-reported" means the model was called with a meaningful
 *  context that the block failed to record — it should not be used as an
 *  anchor so the ring collapses. If ANY cache counter (cache_hit or
 *  cache_write) is non-zero, the round carried real content and is a valid
 *  anchor even when raw input is 0 (e.g. a pure-cache-read response). */
function isUnderReportedUsage(usage: ContextUsageBlock): boolean {
  const src = usage.last_call ?? usage;
  const input = src.input_tokens || 0;
  const cacheHit = src.cache_hit_tokens || 0;
  const cacheWrite = src.cache_creation_tokens || 0;
  const output = src.output_tokens || 0;
  return input === 0 && !cacheHit && !cacheWrite && output > 0;
}

// ──────────────────────────────────────────────────────────────────────────
// The estimator
// ──────────────────────────────────────────────────────────────────────────

function isUsableAnchor(
  msg: ContextEstimateMessage,
): { value: number; underReported: boolean } | undefined {
  if (msg.role !== 'assistant') return undefined;
  if (msg.stopReason === 'aborted' || msg.stopReason === 'error') return undefined;
  const usage = msg.usage ?? msg.tokenUsage;
  if (!usage) return undefined;
  const underReported = isUnderReportedUsage(usage);
  const { prompt } = normalizePromptTokens(usage);
  // The provider's output_tokens / total_tokens describe generated traffic,
  // not context carried into the next request. Add only the assistant content
  // that the harness actually persisted; hidden or discarded output therefore
  // cannot inflate a context anchor. The output payload estimate uses the same
  // block-aware tokenizer as trailing messages.
  if (prompt <= 0) return undefined;
  return { value: prompt + estimateMessageTokens(msg), underReported };
}

/**
 * Compute the current input projection from a message list.
 *
 * 1. Anchored path: latest valid assistant input after the last compaction
 *    boundary + the persisted assistant content on that message + estimated
 *    tokens of everything appended since.
 * 2. Unanchored path: whole-history estimate + `systemPrefixTokens`.
 * 3. Post-compaction stale: an anchor exists but only at/before the last
 *    boundary (it describes the pre-compaction context) AND there are
 *    messages after the boundary → return null ("?") rather than lie.
 */
export function computeContextEstimate(
  messages: readonly ContextEstimateMessage[],
  options: ContextEstimateOptions = {},
): ContextEstimate {
  const empty: ContextEstimate = {
    usedTokens: null,
    anchored: false,
    anchorIndex: null,
    anchorTokens: 0,
    trailingTokens: 0,
    anchorModel: null,
    toolDefinitionsTokens: 0,
  };

  // Last compaction boundary — anchors at or before it are stale.
  let boundaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.isCompactBoundary) {
      boundaryIndex = i;
      break;
    }
  }

  // Backwards scan for the latest usable anchor past the boundary, plus the
  // one before it (under-report fallback base).
  let anchorIndex: number | null = null;
  let anchorValue = 0;
  let anchorUnderReported = false;
  let anchorModel: string | null = null;
  let prevAnchorValue = 0;
  for (let i = messages.length - 1; i > boundaryIndex; i--) {
    const usable = isUsableAnchor(messages[i]);
    if (!usable) continue;
    if (anchorIndex === null) {
      anchorIndex = i;
      anchorValue = usable.value;
      anchorUnderReported = usable.underReported;
      anchorModel = messages[i]?.model || null;
      continue;
    }
    prevAnchorValue = usable.value;
    break;
  }

  if (anchorIndex !== null) {
    let trailing = 0;
    for (let i = anchorIndex + 1; i < messages.length; i++) {
      trailing += estimateMessageTokens(messages[i]);
    }
    // Gateway under-report guard: a fully-cache-served round can report
    // all-zero input components (only output), which would collapse the ring
    // mid-session. When the previous anchor is drastically larger and the
    // latest usage is an obvious under-report, fall back to it as the base.
    // Legitimate shrink paths are unaffected: compaction resets the scan at
    // the boundary, rewind shortens the list itself, and projection offload
    // rounds still report real input counters.
    const base =
      anchorUnderReported && prevAnchorValue > anchorValue + trailing
        ? prevAnchorValue
        : anchorValue;
    return {
      usedTokens: base + trailing,
      anchored: true,
      anchorIndex,
      anchorTokens: base,
      trailingTokens: trailing,
      anchorModel,
      // Anchored: the provider's input_tokens already priced the tool
      // definitions — never add the local schema estimate on top.
      toolDefinitionsTokens: 0,
    };
  }

  // No anchor past the boundary. If the history continues past a boundary,
  // any estimate mixes pre/post-compaction volumes unreliably → "?".
  if (boundaryIndex >= 0 && messages.length > boundaryIndex + 1) {
    return empty;
  }

  // Whole-history estimate (+ system prefix — nothing authoritative exists).
  let tokens = 0;
  for (const msg of messages) tokens += estimateMessageTokens(msg);
  const prefix = options.systemPrefixTokens || 0;
  // Plan 577 §4: unanchored estimates historically missed the tool-schema
  // volume entirely — plugin/MCP-heavy sessions under-counted by the whole
  // surface. Charge it once, here, on the unanchored path only.
  const toolDefinitions = Math.max(0, options.toolDefinitionsTokens || 0);
  const total = (tokens > 0 || prefix > 0 ? tokens + prefix : 0) + toolDefinitions;
  return {
    usedTokens: total,
    anchored: false,
    anchorIndex: null,
    anchorTokens: 0,
    trailingTokens: tokens,
    anchorModel: null,
    toolDefinitionsTokens: toolDefinitions,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ContextComposition (plan 577 §4) — context is not just messages
// ──────────────────────────────────────────────────────────────────────────

/** One labelled slice of the context (bucket diagnostics). */
export interface ContextPart {
  label: string;
  tokens: number;
}

export interface ContextComposition {
  system: ContextPart[];
  conversation: ContextPart[];
  /** Harness injections: system-reminder / turn metadata / workspace status /
   *  memory recall / skill suggestions — the only bucket that keeps
   *  attributing correctly as Plugin/Skill/MCP weight grows. Skill bodies
   *  live in {@link skills}, not here. */
  injectedContext: ContextPart[];
  /** Loaded skill payloads, one part per skill (label `skill:<name>`):
   *  `Skill` tool results, `<skill>` mention injections, and Read results
   *  of a SKILL.md file. Codex parity — the transcript names the skill, so
   *  must the accounting. */
  skills: ContextPart[];
  toolDefinitions: ContextPart[];
  toolResults: ContextPart[];
  attachments: ContextPart[];
  memory: ContextPart[];
  providerOverhead: ContextPart[];
  /** Anchored provider volume not covered by local category estimates.
   *  The headline remains provider-observed; category rows are estimates. */
  unattributedObservedTokens: number;
}

/**
 * Text prefixes that identify a harness-injected payload (plan 577 §4
 * `injectedContext` bucket). Runtime-injected user-role rows carry these
 * markers; extend here when a new injection channel appears.
 */
const HARNESS_INJECTION_PREFIXES = [
  '<system-reminder',
  '<task-notification',
  '[system]',
  '[agent]',
  '[routine]',
  '<runtime_context>',
  '<turn-metadata>',
  '<workspace-status>',
  // Skill-suggestion envelopes are per-turn harness hints (skillMatch.ts) —
  // skill BODIES (the `<skill>` envelope) go to the skills bucket instead.
  '<skill-suggestion>',
] as const;

function isHarnessInjectedText(text: string): boolean {
  const head = text.slice(0, 64);
  return HARNESS_INJECTION_PREFIXES.some((p) => head.includes(p));
}

/** Bucket options extend the estimator's — the composition is computed over
 *  the SAME measurement, never a second-derivation. */
export interface ContextCompositionOptions extends ContextEstimateOptions {
  /** Sub-slices for the system bucket (labelled parts of the prompt).
   *  When absent, a non-zero systemPrefixTokens collapses into one part. */
  systemParts?: ContextPart[];
  /** Sub-slices for the tool-definitions bucket (e.g. per MCP server). */
  toolDefinitionParts?: ContextPart[];
  /** Memory-recall payload priced outside the message timeline. */
  memoryParts?: ContextPart[];
  /** Plan 579: transient `<skill>` mention-injection bodies (agent
   *  projection rail) — priced outside the message timeline like
   *  {@link memoryParts}, labelled `skill:<name>` per skill. */
  skillParts?: ContextPart[];
}

/** Content-block classification for one message's blocks. */
type BlockBucket =
  | 'conversation'
  | 'injectedContext'
  | 'toolResults'
  | 'attachments'
  | 'skills';

function classifyBlockBucket(block: unknown): BlockBucket {
  if (!block || typeof block !== 'object') return 'conversation';
  const b = block as { type?: string };
  switch (b.type) {
    case 'tool_result':
      return 'toolResults';
    case 'image':
      return 'attachments';
    case 'text':
      return typeof (b as { text?: string }).text === 'string' &&
        isHarnessInjectedText((b as { text: string }).text)
        ? 'injectedContext'
        : 'conversation';
    default:
      return 'conversation';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Skill attribution (plan 579)
// ──────────────────────────────────────────────────────────────────────────

/** Tools whose call loads a skill body. `read`/aliases cover the Read-first
 *  fallback path (and any model that reads SKILL.md directly); `skill` is
 *  the dedicated loader. */
const SKILL_LOADER_TOOL_NAMES = new Set(['skill', 'read', 'readfile', 'read_file']);

/** The per-call skill label for a tool_use block, or null when the call
 *  does not load a skill. Label format: `skill:<name>` — `<name>` is the
 *  catalog name (Skill tool input) or the skill's directory name (the
 *  segment before SKILL.md, mirroring codex's "Read SKILL.md (demo skill)"
 *  annotation). */
function skillCallLabel(block: {
  name?: unknown;
  input?: unknown;
}): string | null {
  const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
  if (!SKILL_LOADER_TOOL_NAMES.has(name)) return null;
  const input = block.input as Record<string, unknown> | undefined;
  if (name === 'skill') {
    const skill = typeof input?.skill === 'string' ? input.skill.trim().replace(/^\//, '') : '';
    return skill ? `skill:${skill}` : 'skill';
  }
  const rawPath =
    typeof input?.file_path === 'string'
      ? input.file_path
      : typeof input?.path === 'string'
        ? input.path
        : typeof input?.filePath === 'string'
          ? input.filePath
          : '';
  const segments = rawPath.split(/[\\/]/).filter(Boolean);
  const base = segments[segments.length - 1];
  if (!base || base.toLowerCase() !== 'skill.md') return null;
  const dir = segments[segments.length - 2];
  return dir ? `skill:${dir}` : 'skill';
}

/** The mention-injection envelope the agent wraps skill bodies in
 *  (`<skill>\n<name>…</name>…`). `<skill-suggestion>` blocks are hints, not
 *  loaded bodies, and stay in injectedContext — `startsWith('<skill>')`
 *  already excludes them. */
function isSkillInjectionText(text: string): boolean {
  return text.trimStart().startsWith('<skill>');
}

function skillInjectionLabel(text: string): string {
  const match = text.slice(0, 200).match(/<name>([^<]{1,64})<\/name>/);
  return match ? `skill:${match[1]}` : 'skill';
}

// ──────────────────────────────────────────────────────────────────────────
// Connector / MCP tool-result attribution (tool catalog wire format)
// ──────────────────────────────────────────────────────────────────────────

/** Source kinds of the stable tool-ID wire format (`createToolId` in
 *  @duya/agent catalog-identity: `kind:encodedSourceId:encodedToolName`). */
type InvokeSourceKind = 'builtin' | 'mcp' | 'plugin' | 'connector';

export interface ParsedInvokeToolId {
  kind: InvokeSourceKind;
  /** Decoded source identity — provider id for connectors, server name for
   *  MCP, `pluginId:connection` for plugin-owned MCP servers. */
  source: string;
  /** Decoded per-tool name (may repeat the source as a prefix). */
  toolName: string;
}

/** Parse the stable tool ID produced by the tool catalog. The IDs travel
 *  inside `tool_invoke` inputs, so the composition (and the renderer) can
 *  attribute a call to its connector / MCP source from the transcript
 *  alone — no catalog access required. Returns null for foreign formats. */
export function parseInvokeToolId(raw: string): ParsedInvokeToolId | null {
  const segments = raw.split(':');
  if (segments.length < 3) return null;
  const kind = segments[0];
  if (kind !== 'builtin' && kind !== 'mcp' && kind !== 'plugin' && kind !== 'connector') {
    return null;
  }
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return {
    kind,
    source: decode(segments[1]),
    toolName: decode(segments.slice(2).join(':')),
  };
}

/**
 * Label for a tool_use block whose RESULT should be attributed to its
 * connector / MCP source (label format `connector:<id>` / `mcp:<id>` /
 * `plugin:<id>`), or null when the result stays in the generic toolResults
 * pool (builtin tools).
 *
 * Channels, in priority order:
 * 1. `tool_invoke` — the stable tool ID in the input is authoritative.
 * 2. Eager MCP tools — provider-visible `mcp_<server>_<tool>` names. The
 *    sanitizer collapses the internal `__` separators, so the split is a
 *    heuristic: the FIRST token is the server (tool names are typically
 *    multi-word, server names single-token).
 * 3. Remote-MCP connector aliases — `remote_<provider>_<tool>`.
 */
function invokeResultLabel(block: { name?: unknown; input?: unknown }): string | null {
  const name = typeof block.name === 'string' ? block.name : '';
  if (!name) return null;
  if (name === 'tool_invoke') {
    const input = block.input as Record<string, unknown> | undefined;
    const toolId = typeof input?.tool_id === 'string' ? input.tool_id.trim() : '';
    const parsed = toolId ? parseInvokeToolId(toolId) : null;
    // Builtin deferred tools invoked through tool_invoke stay generic —
    // they are the harness's own tools, not connector/MCP weight.
    return parsed && parsed.kind !== 'builtin' ? `${parsed.kind}:${parsed.source}` : null;
  }
  if (name.startsWith('mcp_')) {
    const rest = name.slice('mcp_'.length);
    const firstSep = rest.indexOf('_');
    const server = firstSep !== -1 ? rest.slice(0, firstSep) : rest;
    return server ? `mcp:${server}` : 'mcp';
  }
  if (name.startsWith('remote_')) {
    const provider = name.slice('remote_'.length).split('_')[0];
    if (provider) return `connector:${provider}`;
  }
  return null;
}

/**
 * Compute the context size AND its composition in one pass (plan 577 §4).
 *
 * The `estimate` inside the result is exactly what
 * {@link computeContextEstimate} would return for the same input — the
 * composition is a projection of the same measurement, not a parallel one.
 *
 * Bucketing rules:
 * - Anchored: the anchor's observed volume is a provider fact and lands in
 *   `unattributedObservedTokens`; every message AFTER the anchor is
 *   block-classified into the buckets. The system/tool/memory overheads are
 *   inside the anchor volume — their buckets stay empty (no double-count).
 *   Bucket sum + unattributed = total.
 * - Unanchored: the whole history is bucketed; the system/tool/memory
 *   overheads come from the labelled options parts.
 * - Empty history + zero overhead → all buckets empty, total 0.
 */
export function computeContextComposition(
  messages: readonly ContextEstimateMessage[],
  options: ContextCompositionOptions = {},
): { estimate: ContextEstimate; composition: ContextComposition } {
  const estimate = computeContextEstimate(messages, options);

  const anchorBuckets: Record<BlockBucket, ContextPart[]> = {
    conversation: [],
    injectedContext: [],
    toolResults: [],
    attachments: [],
    skills: [],
  };
  const trailingBuckets: Record<BlockBucket, ContextPart[]> = {
    conversation: [],
    injectedContext: [],
    toolResults: [],
    attachments: [],
    skills: [],
  };
  let currentMessageIndex = -1;
  const push = (bucket: BlockBucket, label: string, tokens: number): void => {
    if (tokens <= 0) return;
    const isTrailing =
      estimate.anchored &&
      estimate.anchorIndex !== null &&
      currentMessageIndex > estimate.anchorIndex;
    (isTrailing ? trailingBuckets : anchorBuckets)[bucket].push({ label, tokens });
  };

  // Track the last compaction boundary so old, discarded history is never
  // assigned to the current prompt's composition.
  let boundaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.isCompactBoundary) {
      boundaryIndex = i;
      break;
    }
  }

  // tool_use id → skill label, so the paired tool_result (usually the next
  // user message) lands in the skills bucket with the skill's name.
  const skillUseByCallId = new Map<string, string>();
  // tool_use id → connector/MCP source label, so invoke results attribute to
  // `connector:<id>` / `mcp:<id>` / `plugin:<id>` parts instead of the
  // generic toolResults pool (the "MCP 工具结果暂未独立" plan 577 gap).
  const toolSourceLabelByCallId = new Map<string, string>();

  if (estimate.usedTokens !== null) {
    for (let i = estimate.anchored ? boundaryIndex + 1 : 0; i < messages.length; i++) {
      currentMessageIndex = i;
      const msg = messages[i];
      if (typeof msg.content === 'string') {
        push(
          isSkillInjectionText(msg.content)
            ? 'skills'
            : isHarnessInjectedText(msg.content)
              ? 'injectedContext'
              : 'conversation',
          isSkillInjectionText(msg.content)
            ? skillInjectionLabel(msg.content)
            : `${msg.role}#${i}`,
          estimateMessageTokens(msg),
        );
        continue;
      }
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        // Per-block cost through the SAME block-aware estimator the timeline
        // scan uses (single-block array) — tool_result recursion, image
        // floor, thinking and tool_use input are priced identically, so the
        // bucket sum equals the trailing estimate exactly.
        const tokens = estimateMessageTokens({ role: msg.role, content: [block] });
        const b = block as {
          type?: string;
          id?: unknown;
          name?: unknown;
          input?: unknown;
          tool_use_id?: unknown;
          text?: unknown;
        };
        if (b?.type === 'tool_use') {
          const label = skillCallLabel(b as { name?: unknown; input?: unknown });
          if (label && typeof b.id === 'string') skillUseByCallId.set(b.id, label);
          const sourceLabel = invokeResultLabel(b as { name?: unknown; input?: unknown });
          if (sourceLabel && typeof b.id === 'string') {
            toolSourceLabelByCallId.set(b.id, sourceLabel);
          }
          push('conversation', `${msg.role}#${i}.${j}`, tokens);
          continue;
        }
        if (b?.type === 'tool_result') {
          const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
          const label = id ? skillUseByCallId.get(id) : undefined;
          if (label) {
            push('skills', label, tokens);
          } else {
            const sourceLabel = id ? toolSourceLabelByCallId.get(id) : undefined;
            push('toolResults', sourceLabel ?? `${msg.role}#${i}.${j}`, tokens);
          }
          continue;
        }
        if (
          b?.type === 'text' &&
          typeof b.text === 'string' &&
          isSkillInjectionText(b.text)
        ) {
          push('skills', skillInjectionLabel(b.text), tokens);
          continue;
        }
        push(classifyBlockBucket(block), `${msg.role}#${i}.${j}`, tokens);
      }
    }
  }

  const systemPrefix = options.systemPrefixTokens || 0;
  // These values only contribute to the headline on an unanchored estimate.
  // On the anchored path they are local category estimates inside the measured
  // provider total, so they help explain it without being added a second time.
  const overheadLabelled = estimate.usedTokens !== null;
  const systemParts: ContextPart[] = !overheadLabelled
    ? []
    : options.systemParts && options.systemParts.length > 0
      ? options.systemParts.filter((p) => p.tokens > 0)
      : systemPrefix > 0
        ? [{ label: 'system', tokens: systemPrefix }]
        : [];

  const toolDefinitionParts: ContextPart[] = !overheadLabelled
    ? []
    : options.toolDefinitionParts && options.toolDefinitionParts.length > 0
      ? options.toolDefinitionParts.filter((p) => p.tokens > 0)
      : (options.toolDefinitionsTokens || 0) > 0
        ? [{ label: 'tool definitions', tokens: options.toolDefinitionsTokens || 0 }]
        : [];

  const memoryParts: ContextPart[] = !overheadLabelled
      ? []
      : (options.memoryParts ?? []).filter((p) => p.tokens > 0);

  // Plan 579: injected skill bodies ride the transient projection rail, not
  // the message timeline — same outside-the-timeline pricing as memory.
  const skillOptionParts: ContextPart[] = !overheadLabelled
      ? []
      : (options.skillParts ?? []).filter((p) => p.tokens > 0);

  const anchorParts = [
    ...Object.values(anchorBuckets),
    systemParts,
    toolDefinitionParts,
    memoryParts,
    skillOptionParts,
  ];  const anchorClassifiedTokens = anchorParts.reduce(
    (total, parts) => total + contextPartsTotal(parts),
    0,
  );
  // A rough local tokenizer can exceed the provider's observed anchor. Scale
  // its category shares down in that case; never let estimates inflate the
  // measured headline. Any under-estimated remainder stays explicitly
  // unattributed instead of being assigned to a guessed category.
  const anchorScale =
    estimate.anchored && anchorClassifiedTokens > estimate.anchorTokens
      ? estimate.anchorTokens / anchorClassifiedTokens
      : 1;
  const scaleParts = (parts: ContextPart[]): ContextPart[] =>
    parts.map((part) => ({ ...part, tokens: Math.floor(part.tokens * anchorScale) }));
  const combineBuckets = (bucket: BlockBucket): ContextPart[] => [
    ...scaleParts(anchorBuckets[bucket]),
    ...trailingBuckets[bucket],
  ];
  const attributedAnchorTokens = anchorParts.reduce(
    (total, parts) => total + contextPartsTotal(scaleParts(parts)),
    0,
  );

  return {
    estimate,
    composition: {
      system: scaleParts(systemParts),
      conversation: combineBuckets('conversation'),
      injectedContext: combineBuckets('injectedContext'),
      skills: [...combineBuckets('skills'), ...scaleParts(skillOptionParts)],
      toolDefinitions: scaleParts(toolDefinitionParts),
      toolResults: combineBuckets('toolResults'),
      attachments: combineBuckets('attachments'),
      memory: scaleParts(memoryParts),
      providerOverhead: [],
      unattributedObservedTokens: estimate.anchored
        ? Math.max(0, estimate.anchorTokens - attributedAnchorTokens)
        : 0,
    },
  };
}

/** Total across a bucket — the sum every diagnostic surface renders. */
export function contextPartsTotal(parts: readonly ContextPart[]): number {
  return parts.reduce((sum, p) => sum + p.tokens, 0);
}
