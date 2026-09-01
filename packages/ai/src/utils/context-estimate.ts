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
}

export interface ContextEstimateOptions {
  /** Estimated system prompt + tool definitions. Added ONLY when no usage
   *  anchor exists — once anchored, the API's input_tokens already includes
   *  the prefix, and adding it again would double-count. */
  systemPrefixTokens?: number;
}

export interface ContextEstimate {
  /** Full context size. `null` = unknowable right now (post-compaction,
   *  no post-compaction response yet) → UI shows "?" instead of guessing. */
  usedTokens: number | null;
  /** True when driven by a real API usage anchor; false = local estimate. */
  anchored: boolean;
  /** Index of the message providing the anchor, or null. */
  anchorIndex: number | null;
  anchorTokens: number;
  trailingTokens: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** CJK scripts cost ~2.5 chars/token under BPE tokenizers. */
const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;
const CJK_CHARS_PER_TOKEN = 2.5;
const ASCII_CHARS_PER_TOKEN = 4;

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
 * Normalize a usage block into the full prompt volume the model saw.
 *
 * Anthropic reports `input_tokens` EXCLUDING cache read/write; many
 * OpenAI-compatible gateways map `prompt_tokens` (which INCLUDES cached
 * tokens) onto the same field names, so field names alone cannot
 * distinguish the conventions. Heuristic (matches pi / legacy renderer):
 * if any cache counter exceeds raw input, the input cannot already contain
 * it — add all cache tokens back; otherwise assume they are included.
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
    cacheHit > input || cacheWrite > input ? input + cacheHit + cacheWrite : input;
  return { prompt, output };
}

/** True when a usage block reports output but ALL input-side counters are
 *  zero. Some gateways omit the cached volume entirely on fully-cached
 *  rounds, so the block cannot be trusted as a context-size anchor. */
function isUnderReportedUsage(usage: ContextUsageBlock): boolean {
  const src = usage.last_call ?? usage;
  return (
    (src.input_tokens || 0) === 0 &&
    (src.cache_hit_tokens || 0) === 0 &&
    (src.cache_creation_tokens || 0) === 0 &&
    (src.output_tokens || 0) > 0
  );
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
  const { prompt, output } = normalizePromptTokens(usage);
  // Provider-reported total_tokens (OpenAI-compatible gateways) is the most
  // authoritative anchor when present, but only trust it when it's larger than
  // the cache-normalized prompt — gateways that omit cache from total_tokens
  // would otherwise silently under-count the anchor and miss compaction.
  let total: number;
  if (typeof usage.total_tokens === 'number' && usage.total_tokens > 0) {
    total = Math.max(usage.total_tokens, prompt + output);
  } else {
    total = prompt + output;
  }
  // All-zero usage renders as an empty ring; cache-only requests (input=0,
  // large hits) are meaningful and survive via normalizePromptTokens.
  if (total <= 0) return undefined;
  return { value: total, underReported };
}

/**
 * Compute the current context size from a message list.
 *
 * 1. Anchored path: latest valid assistant usage after the last compaction
 *    boundary + estimated tokens of everything appended since.
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
  let prevAnchorValue = 0;
  for (let i = messages.length - 1; i > boundaryIndex; i--) {
    const usable = isUsableAnchor(messages[i]);
    if (!usable) continue;
    if (anchorIndex === null) {
      anchorIndex = i;
      anchorValue = usable.value;
      anchorUnderReported = usable.underReported;
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
  return {
    usedTokens: tokens > 0 || prefix > 0 ? tokens + prefix : 0,
    anchored: false,
    anchorIndex: null,
    anchorTokens: 0,
    trailingTokens: tokens,
  };
}
