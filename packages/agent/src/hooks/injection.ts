/**
 * Hook context injection governance (context-injection hardening).
 *
 * Every channel that feeds hook `additionalContext` into the model context
 * (LoopHookBus inject effects, the `promptContexts` rail, PreToolUse
 * advisories) funnels its content through this module before the text
 * reaches a `<system-reminder>` block. The governor provides four controls
 * that the raw pipeline lacked:
 *
 *   1. **Envelope** — each block is wrapped in `<hook-context …>` with
 *      structured provenance (event / hook / tool / seq) so the model can
 *      attribute the feedback and downstream tooling can parse it.
 *   2. **Budget** — per-hook token threshold (`additional_context_limit`,
 *      default 2500 tokens, codex parity). Over-budget content is spilled
 *      to disk and injected as preview + file pointer, mirroring the
 *      large-pasted-attachment pointer pattern.
 *   3. **Dedup / replace-last** — identical re-injections within a run are
 *      skipped; a newer output for the same hook key replaces the previous
 *      block in place (verifier output is "latest state" semantics).
 *   4. **Metrics** — every decision is logged at DEBUG with the action
 *      taken so injection volume is observable.
 *
 * Fail-open: spill write failures degrade to a hard truncate, never throw.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { logger } from '../utils/logger.js';
import { resolveConfigRoot } from './config.js';

/** Default per-hook injection budget (codex `additional_context_limit` parity). */
export const DEFAULT_HOOK_CONTEXT_LIMIT_TOKENS = 2500;

/** Rough chars-per-token factor. Deliberately conservative (over-estimates). */
const CHARS_PER_TOKEN = 4;

/** Fraction of the character budget kept as head preview when spilling. */
const SPILL_HEAD_FRACTION = 0.7;

// ============================================================================
// Envelope
// ============================================================================

/** Provenance stamped onto every governed hook-context block. */
export interface HookContextInfo {
  /** Hook lifecycle event (e.g. `PostToolUse`). */
  event: string;
  /** Hook identifier — command line / URL / prompt summary. */
  hookName: string;
  /** Executor type when known (command / process / prompt / http / agent). */
  hookType?: string;
  /** Tool name when the event is tool-scoped. */
  toolName?: string;
  /** Associated tool_use_id when available. */
  toolUseId?: string;
  /** Per-runner dispatch sequence. */
  seq?: number;
}

/** Flatten attribute values to safe single-line strings. */
function attr(value: string | number | undefined): string {
  if (value === undefined) return '';
  return String(value)
    .replace(/[\r\n"\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wrap content in a `<hook-context>` envelope with provenance attributes.
 * The envelope stays parseable by downstream dedup/UI tooling and lets the
 * model attribute feedback to the hook that produced it.
 */
export function renderHookContextEnvelope(info: HookContextInfo, content: string): string {
  const attrs = [
    `event="${attr(info.event)}"`,
    `hook="${attr(info.hookName)}"`,
    info.hookType ? `type="${attr(info.hookType)}"` : null,
    info.toolName ? `tool="${attr(info.toolName)}"` : null,
    info.toolUseId ? `tool_use_id="${attr(info.toolUseId)}"` : null,
    info.seq !== undefined ? `seq="${info.seq}"` : null,
  ]
    .filter((a): a is string => a !== null)
    .join(' ');
  return `<hook-context ${attrs}>\n${content}\n</hook-context>`;
}

// ============================================================================
// Budget: estimate / truncate / spill
// ============================================================================

/** Rough token estimate (chars / 4, rounded up). Good enough for budgets. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Where spilled hook outputs land. Namespace keeps sessions isolated. */
function spillFilePath(sessionId: string | undefined, info: HookContextInfo, baseDir?: string): string {
  const base = baseDir ?? path.join(resolveConfigRoot(), 'hook-context');
  const ns = (sessionId ?? 'adhoc').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'adhoc';
  const slug = attr(info.hookName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'hook';
  const dir = path.join(base, ns);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${Date.now()}-${info.seq ?? 0}-${slug}.txt`);
}

/**
 * Keep the head and tail of `text` within `budgetChars`, dropping the middle.
 * Verifier outputs typically carry the summary at both ends (banner + final
 * counts), which is exactly what a head+tail cut preserves.
 */
function headTail(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text;
  const headLen = Math.floor(budgetChars * SPILL_HEAD_FRACTION);
  const tailLen = budgetChars - headLen;
  const dropped = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n[… ${dropped} chars dropped …]\n${text.slice(text.length - tailLen)}`;
}

/** Result of governing one hook's additionalContext. */
export interface GovernedContext {
  /** Final text ready for envelope wrapping and injection. */
  content: string;
  /** What the governor did to the raw output. */
  action: 'full' | 'truncated' | 'spilled' | 'hard-truncated';
  /** Estimated tokens of `content`. */
  estimatedTokens: number;
}

export interface GovernOptions {
  /**
   * Per-hook token threshold. `undefined` → default (2500). `0` → spilling
   * disabled, over-budget content is hard truncated in place.
   */
  limitTokens?: number;
  /** Session id used to namespace the spill directory. */
  sessionId?: string;
  /** Test seam: overrides the spill directory root. */
  spillDir?: string;
  /** Disable disk spilling entirely (hard truncate only). */
  disableSpill?: boolean;
}

/**
 * Apply the per-hook budget to one hook's raw `additionalContext`.
 * Within budget → verbatim. Over budget with spilling enabled → full text
 * written to disk, preview + Read-pointer returned. Spill disabled or write
 * failure → head+tail hard truncate. Never throws.
 */
export function governHookContext(
  raw: string,
  info: HookContextInfo,
  opts: GovernOptions = {},
): GovernedContext {
  const estimated = estimateTokens(raw);
  const limitTokens = opts.limitTokens ?? DEFAULT_HOOK_CONTEXT_LIMIT_TOKENS;
  const logMeta = { event: info.event, hook: info.hookName.slice(0, 80) };

  if (estimated <= limitTokens) {
    logger.debug('[HookInject] within budget', { ...logMeta, tokens: estimated, action: 'full' });
    return { content: raw, action: 'full', estimatedTokens: estimated };
  }

  // `0` explicitly disables spilling — hard truncate only.
  if (limitTokens === 0 || opts.disableSpill === true) {
    const content = headTail(raw, limitTokens * CHARS_PER_TOKEN);
    logger.debug('[HookInject] hard-truncated (spilling disabled)', {
      ...logMeta, tokens: estimated, action: 'hard-truncated',
    });
    return { content, action: 'hard-truncated', estimatedTokens: estimateTokens(content) };
  }

  try {
    const file = spillFilePath(opts.sessionId, info, opts.spillDir);
    fs.writeFileSync(file, raw, 'utf-8');
    const previewChars = limitTokens * CHARS_PER_TOKEN;
    const content =
      `[hook output ${estimated} tokens > limit ${limitTokens}; full output saved to ${file} — read it with the Read tool if needed]\n`
      + headTail(raw, previewChars);
    logger.debug('[HookInject] spilled to disk', {
      ...logMeta, tokens: estimated, action: 'spilled', file,
    });
    return { content, action: 'spilled', estimatedTokens: estimateTokens(content) };
  } catch (err) {
    logger.warn(
      `[HookInject] spill write failed (${err instanceof Error ? err.message : String(err)}); falling back to hard truncate`,
      logMeta,
    );
    const content = headTail(raw, limitTokens * CHARS_PER_TOKEN);
    return { content, action: 'hard-truncated', estimatedTokens: estimateTokens(content) };
  }
}

// ============================================================================
// Dedup / replace-last
// ============================================================================

/** Metadata key stamped on hook-injected provider messages (replace-last anchor). */
export const HOOK_CONTEXT_KEY_METADATA = 'hookContextKey';

/** Metadata key carrying the fnv1a hash of the injected content. */
export const HOOK_CONTEXT_HASH_METADATA = 'hookContentHash';

/** Minimal message shape the injector operates on (duya `Message` subset). */
export interface InjectableMessage {
  id: string;
  role: 'user';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** FNV-1a 32-bit hash, hex-encoded. Collision-safe enough for dedup. */
export function hashContext(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Outcome of {@link applyHookInjection}. */
export type InjectAction = 'injected' | 'deduped' | 'replaced';

export interface ApplyInjectionOptions {
  /** Message id; generated internally when omitted. */
  id?: string;
  now: number;
}

/**
 * Single chokepoint for pushing one governed hook block into the working
 * provider-message array:
 *
 *   - identical content already present anywhere in the run → **deduped**
 *     (the model has seen it; re-injecting wastes window),
 *   - an earlier block with the same `dedupKey` exists → **replaced** in
 *     place (latest-state semantics for verifier-style hooks),
 *   - otherwise appended (**injected**).
 *
 * Without a `dedupKey` the call degrades to plain append + hash stamping.
 * Returns the action taken so callers can log it.
 */
export function applyHookInjection(
  messages: InjectableMessage[],
  dedupKey: string | undefined,
  content: string,
  source: string,
  opts: ApplyInjectionOptions,
): InjectAction {
  const hash = hashContext(content);

  if (messages.some((m) => m.metadata?.[HOOK_CONTEXT_HASH_METADATA] === hash)) {
    logger.debug('[HookInject] deduped identical block', { key: dedupKey, hash });
    return 'deduped';
  }

  if (dedupKey) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.metadata?.[HOOK_CONTEXT_KEY_METADATA] === dedupKey) {
        m.content = content;
        m.metadata = { ...m.metadata, [HOOK_CONTEXT_HASH_METADATA]: hash };
        logger.debug('[HookInject] replaced previous block in place', { key: dedupKey, hash });
        return 'replaced';
      }
    }
  }

  messages.push({
    id: opts.id ?? randomUUID(),
    role: 'user',
    content,
    timestamp: opts.now,
    metadata: {
      runtimeContext: true,
      source,
      [HOOK_CONTEXT_HASH_METADATA]: hash,
      ...(dedupKey ? { [HOOK_CONTEXT_KEY_METADATA]: dedupKey } : {}),
    },
  });
  logger.debug('[HookInject] injected', { key: dedupKey, hash });
  return 'injected';
}
