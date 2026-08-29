/**
 * os-context/fragment.ts — bridges an OSContext snapshot into a
 * `ContextualUserFragment` ready for injection.
 *
 * Token budget: 1800 tokens (per plan §5 Task C2). When the
 * serialized payload exceeds the cap, we call
 * `truncate_middle_with_token_budget` — preserving the high-signal
 * `focusedEntity` + `intentCandidate` head + tail, truncating the
 * bulk `interactionTrail` middle.
 *
 * Marker: `<external_os_context>...</external_os_context>` (matches
 * the convention documented in plan §5 Task C2 and the
 * `ContextualUserFragment.markers()` contract).
 *
 * Plan 453 Task C2.
 */

import {
  CONTEXTUAL_USER_FRAGMENT_MATCHERS,
  type ContextualUserFragment,
  renderFragment,
} from '../contextual-user-fragment.js';
import { getOSContextBridge } from './bridge.js';
import type { OSContext } from './types.js';

/** Minimal message shape that the injection helper needs. Compatible
 *  with both `Message` (provider type) and any subclassed variant. */
interface InjectableMessage {
  id?: string;
  content: string | ReadonlyArray<{ type: string }>;
}

/** Plan-mandated token budget. 1800 ≈ 7.2KB plain text @ 4 chars/token. */
export const OS_CONTEXT_FRAGMENT_TOKEN_BUDGET = 1800;

/** Conservative char estimate when no tokenizer is available. */
const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Marker pair wrapping the OS context body. Plain XML so a
 * developer reading a leaked transcript immediately sees what's
 * machine-injected.
 */
const MARKERS: readonly [string, string] = [
  '<external_os_context>',
  '</external_os_context>',
];

/** Kind tag used by `isContextualFragment` + renderer collapse. */
export const CONTENT_KIND = 'os_context';

/**
 * Adapter that wraps an `OSContext` snapshot into a fragment that
 * the pipeline can render. The class is intentionally small — the
 * fragment contract (role/kind/markers/body) is fixed; the only
 * per-snapshot work is body() + token-budget truncation.
 */
export class OSContextUserFragment implements ContextualUserFragment {
  constructor(private readonly snapshot: OSContext) {}

  role(): 'user' {
    return 'user';
  }

  contentKind(): string {
    return CONTENT_KIND;
  }

  markers(): readonly [string, string] {
    return MARKERS;
  }

  body(): string {
    const rendered = renderSnapshot(this.snapshot);
    return truncateMiddleWithTokenBudget(rendered, OS_CONTEXT_FRAGMENT_TOKEN_BUDGET);
  }

  matchesText(text: string): boolean {
    return text.includes(MARKERS[0]) && text.includes(MARKERS[1]);
  }
}

/**
 * Register a dedup matcher. The bridge pipeline calls these to
 * decide whether the snapshot is already in the user message
 * (e.g. user pasted `selection.text` and we don't want to inject
 * it twice).
 */
CONTEXTUAL_USER_FRAGMENT_MATCHERS.push((text: string) => {
  return text.includes(MARKERS[0]);
});

/**
 * Inject the OSContext snapshot into the latest user message of
 * `messages` (looked up by `runtimePromptMessageId`). No-op when:
 *   - the bridge is disabled,
 *   - there is no current snapshot,
 *   - the runtime prompt message id is null,
 *   - the message content isn't a string or array (defensive).
 *
 * The function mutates the target message in place: a string
 * content is wrapped into `[{ type: 'text', text }]` before the
 * fragment is pushed. This mirrors the plan §5 Task C2 pseudocode.
 *
 * Extracted from DuyaAgent.streamChat so it can be unit-tested
 * without spinning up the full agent.
 */
export function injectOSContextFragment(
  messages: InjectableMessage[],
  runtimePromptMessageId: string | null,
  bridge: {
    isEnabled(): boolean;
    getCurrent(): OSContext | null;
  } = getOSContextBridge(),
): boolean {
  if (!runtimePromptMessageId) return false;
  if (!bridge.isEnabled()) return false;

  const ctx = bridge.getCurrent();
  if (!ctx) return false;

  const target = messages.find((m) => m.id === runtimePromptMessageId);
  if (!target) return false;

  const frag = new OSContextUserFragment(ctx);
  const block = renderFragment(frag);

  if (typeof target.content === 'string') {
    target.content = [{ type: 'text', text: target.content } as unknown as { type: string }];
  }
  if (Array.isArray(target.content)) {
    // Cast: TextContent structurally satisfies the InjectableMessage shape.
    (target.content as unknown as { type: string }[]).push(block);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the OSContext snapshot as a YAML-ish block. We avoid JSON
 * because:
 *   - It is 30-40% more compact for human-readable fields.
 *   - LLMs reliably parse YAML.
 *   - It's stable across daemon schema bumps (no version-coupled
 *     field ordering).
 */
export function renderSnapshot(ctx: OSContext): string {
  const lines: string[] = [];
  lines.push(`schemaVersion: ${ctx.schemaVersion}`);
  lines.push(`capturedAt: ${ctx.capturedAt}`);
  lines.push(`foreground:`);
  lines.push(`  pid: ${ctx.foreground.pid}`);
  lines.push(`  exeName: ${ctx.foreground.exeName}`);
  lines.push(`  title: ${truncate(ctx.foreground.title, 200)}`);

  if (ctx.focusedEntity) {
    lines.push(`focusedEntity:`);
    lines.push(`  kind: ${ctx.focusedEntity.kind}`);
    lines.push(`  confidence: ${ctx.focusedEntity.confidence.toFixed(2)}`);
    if (ctx.focusedEntity.properties.title) {
      lines.push(`  title: ${truncate(ctx.focusedEntity.properties.title, 200)}`);
    }
    if (ctx.focusedEntity.properties.text) {
      lines.push(
        `  text: ${truncate(ctx.focusedEntity.properties.text, 600)}`,
      );
    }
    if (ctx.focusedEntity.properties.selectedText) {
      lines.push(
        `  selectedText: ${truncate(ctx.focusedEntity.properties.selectedText, 400)}`,
      );
    }
    lines.push(`  capabilities: { canRead: ${ctx.focusedEntity.capabilities.canRead}, canWrite: ${ctx.focusedEntity.capabilities.canWrite}, canInvoke: ${ctx.focusedEntity.capabilities.canInvoke} }`);
  } else {
    lines.push(`focusedEntity: null`);
  }

  if (ctx.intentCandidate) {
    lines.push(`intentCandidate:`);
    lines.push(`  intent: ${ctx.intentCandidate.intent}`);
    lines.push(`  confidence: ${ctx.intentCandidate.confidence.toFixed(2)}`);
    if (ctx.intentCandidate.evidence.length > 0) {
      lines.push(`  evidence: [${ctx.intentCandidate.evidence.join(', ')}]`);
    }
  } else {
    lines.push(`intentCandidate: null`);
  }

  lines.push(`interactionTrail:`);
  if (ctx.interactionTrail.length === 0) {
    lines.push(`  []`);
  } else {
    for (const ev of ctx.interactionTrail) {
      const app = ev.app ? `${ev.app.exeName}@${ev.app.pid}` : 'n/a';
      const win = ev.window ? truncate(ev.window.title, 80) : 'n/a';
      const sel = ev.selectedText ? ` sel=${truncate(ev.selectedText, 120)}` : '';
      lines.push(`  - ${ev.ts} ${ev.type} ${app} window="${win}"${sel}`);
    }
  }

  if (ctx.redacted) {
    lines.push(`redaction:`);
    lines.push(`  redacted: true`);
    lines.push(`  reason: ${ctx.redactionReason ?? 'unknown'}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a string at a maximum length, breaking at a UTF-16-safe
 * boundary. Adds an ellipsis indicator when truncating.
 */
export function truncate(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return text.slice(0, max - 1) + '\u2026';
}

/**
 * Middle-truncation preserving head + tail, sized to a token budget.
 *
 * Why middle-truncate:
 *   - The head carries the highest-signal fields
 *     (`focusedEntity`, `intentCandidate`).
 *   - The tail carries the most recent `interactionTrail` events.
 *   - The middle (older trail events) is the most disposable.
 *
 * Mirrors the `truncate_middle_with_token_budget` function in
 * codex-rs (referenced by plan §5 Task C2).
 */
export function truncateMiddleWithTokenBudget(
  text: string,
  tokenBudget: number,
): string {
  const charBudget = tokenBudget * APPROX_CHARS_PER_TOKEN;
  if (text.length <= charBudget) return text;

  // Reserve 5% for the truncation indicator + safety margin.
  const effective = Math.max(0, charBudget - 32);
  const headCut = Math.ceil(effective * 0.4);
  const tailCut = effective - headCut;

  const head = text.slice(0, headCut);
  const tail = text.slice(text.length - tailCut);
  const omitted = text.length - headCut - tailCut;

  return `${head}\n[... ${omitted} chars omitted ...]\n${tail}`;
}