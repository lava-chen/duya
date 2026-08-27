/**
 * contextual-user-fragment.ts — base interface for injecting
 * context into the user-message stream on every turn.
 *
 * Modeled on codex `codex-rs/context-fragments/src/additional_context.rs`
 * (referenced in plan §2 decision #1). Each fragment:
 *
 *   1. Identifies which side of the conversation it lives on
 *      (`role(): 'user' | 'developer'`).
 *   2. Names itself (`contentKind(): string`) so the renderer can
 *      collapse / hide it (we keep these hidden in the UI; the
 *      fragment is purely a model-side signal).
 *   3. Wraps its body in paired markers (`markers(): [open, close]`)
 *      so an accidental leak into training data / replay is visible.
 *   4. Renders the body to a string via `body()`.
 *
 * The fragment is rendered into a `MessageContent` block by
 * `renderFragment` and concatenated into `userMessage.content`.
 *
 * Concurrency / pipeline position:
 *   - Fragments are collected RIGHT AFTER `applyModes` and BEFORE the
 *     first LLM call (see DuyaAgent.streamChat).
 *   - Order matters: later fragments see earlier ones via
 *     `markers()` collision check (we don't currently merge, but
 *     matchers let consumers opt-out of duplicates).
 *
 * Why a separate channel:
 *   - `applyModes.prompt.prefixes` mutates the system prompt.
 *     OSContext changes every ~500ms; injecting it there would
 *     invalidate system-prompt cache on every turn.
 *   - `applyModes.toolUseContextPatch` carries semantic fields
 *     (canvasId, etc.). Not appropriate for bulk telemetry.
 *   - This fragment lives in user-message content, which most
 *     providers cache independently of system prompt.
 *
 * Plan 453 Task C1.
 */

import type { MessageContent, TextContent } from '@duya/ai';

/** Side of the conversation the fragment should be appended to. */
export type FragmentRole = 'user' | 'developer';

/**
 * A piece of contextual telemetry the agent wants to inject into the
 * per-turn user message without polluting the system prompt or
 * durable message history.
 */
export interface ContextualUserFragment {
  /** Which side of the conversation this fragment lives on. */
  role(): FragmentRole;

  /**
   * Stable identifier for the fragment kind. Used by:
   *   - the renderer (collapse / hide)
   *   - tests (match specific fragments)
   *   - duplication guards (see CONTEXTUAL_USER_FRAGMENT_MATCHERS)
   */
  contentKind(): string;

  /**
   * Paired open / close markers that wrap the body. Used so an
   * accidental leak into a transcript / training snapshot is
   * obvious to humans reading the dump.
   *
   * Convention: `<open_kind>` and `</open_kind>` (mirrors XML).
   */
  markers(): readonly [open: string, close: string];

  /**
   * Render the fragment body. The `markers()` are applied
   * automatically by `renderFragment`; this returns the inner text.
   *
   * Implementations should respect the agreed token budget (see
   * OSContextUserFragment's 1800 cap).
   */
  body(): string;

  /**
   * Optional collision guard: returns `true` if `text` already
   * contains this fragment's body verbatim. Useful when the same
   * context appears in multiple sources and we want to dedupe.
   */
  matchesText?(text: string): boolean;
}

/**
 * Render a fragment to a `MessageContent` block ready to push onto
 * `userMessage.content`. The block is wrapped in `markers()`.
 */
export function renderFragment(frag: ContextualUserFragment): TextContent {
  const [open, close] = frag.markers();
  const text = `${open}\n${frag.body()}\n${close}`;
  // We mark the block as a text fragment the renderer can hide.
  return {
    type: 'text',
    text,
  } satisfies TextContent;
}

/**
 * Discriminator for "is this content item a contextual fragment?".
 * Used by the renderer / test helpers to filter or inspect injected
 * blocks. Matches by contentKind marker prefix.
 */
export function isContextualFragment(
  block: MessageContent,
  expectedKind?: string,
): boolean {
  if (!block || typeof block !== 'object') return false;
  if (block.type !== 'text') return false;
  const text = (block as TextContent).text;
  if (typeof text !== 'string') return false;
  // Markers wrap the body; we look for the `<external_kind>` shape.
  if (expectedKind) {
    return text.includes(`<external_${expectedKind}>`);
  }
  return /^<external_/.test(text);
}

/**
 * Render a list of fragments into a single concatenated text block.
 * Useful when the caller prefers one block over many. Concatenation
 * preserves each fragment's markers (so consumers can still split).
 */
export function renderFragments(
  fragments: readonly ContextualUserFragment[],
): TextContent {
  const text = fragments.map((f) => renderFragment(f).text).join('\n\n');
  return { type: 'text', text };
}

/**
 * Ordered registry of matchers. The bridge pipeline calls these
 * matchers to decide whether to inject a fragment (e.g. a fragment
 * that matches existing user content can be skipped to avoid
 * duplication).
 */
export const CONTEXTUAL_USER_FRAGMENT_MATCHERS: Array<
  (text: string) => boolean
> = [];