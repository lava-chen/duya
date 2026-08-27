/**
 * orb-insert-tab.ts — Insert Tab action.
 *
 * Plan 453 Task I. Type a string into the currently-focused input
 * field via @nut-tree-fork/nut-js keyboard.type(). Refuses when the
 * daemon has marked the field redacted (password manager in the
 * foreground or focus is on a password input).
 *
 * Why this lives in electron/services and not the agent bundle:
 *   - nut.js is a native module that we want to load on demand in
 *     the main process (a renderer / preload invocation is not
 *     possible with sandbox: true).
 *   - Insert Tab is a side effect on the user's desktop; the agent
 *     should not be able to trigger it without an explicit user
 *     gesture, which the orb Button click is.
 *
 * Lifecycle:
 *   - Module load is lazy. The first Insert Tab press pays the
 *     import cost (~50-200ms on Windows for the nut native module);
 *     subsequent calls are fast.
 *   - The focusedEntity is read from OSContextBridge. The bridge
 *     is enabled by wake.ts when the orb wakes; consumers should
 *     call enable() / disable() around their use.
 */

import { getLogger, LogComponent } from '../logging/logger.js';
import { getOSContextBridge } from '../../packages/agent/dist/context/os-context/index.js';

const logger = getLogger();

/** Per-character delay in ms; matches the daemon's v0.4 typing cadence. */
const TYPING_DELAY_MS = 10;

export interface InsertTabResult {
  ok: boolean;
  /** What we did. */
  method?: 'nut.type';
  /** Reject reason. */
  reason?: string;
  /** Number of characters typed. */
  length?: number;
}

/**
 * Insert text into the currently-focused field.
 *
 * Refuses when:
 *   - OSContextBridge is disabled (no snapshot available)
 *   - the focused entity is null (no field to type into)
 *   - the focused entity is a password field (`focusedEntity.kind`
 *     is `Text` and the daemon reports a redaction)
 *   - the focused entity is not a Text or StreamingText kind
 *
 * Returns a structured result so the IPC layer can surface a
 * non-throwing rejection to the renderer.
 */
export async function insertTabToFocusedField(
  text: string,
): Promise<InsertTabResult> {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'text-not-string' };
  }
  if (text.length === 0) {
    return { ok: true, method: 'nut.type', length: 0 };
  }

  const bridge = getOSContextBridge();
  if (!bridge.isEnabled()) {
    return { ok: false, reason: 'os-context-bridge-disabled' };
  }

  const ctx = bridge.getCurrent();
  if (!ctx) {
    return { ok: false, reason: 'no-os-context-snapshot' };
  }
  if (ctx.redacted) {
    logger.warn(
      'Insert Tab refused: focused field is redacted (password manager or password input)',
      {
        reason: ctx.redactionReason,
        exeName: ctx.foreground.exeName,
      },
      LogComponent.Orb,
    );
    return { ok: false, reason: 'focused-field-redacted' };
  }
  if (!ctx.focusedEntity) {
    return { ok: false, reason: 'no-focused-entity' };
  }
  if (ctx.focusedEntity.kind !== 'Text' && ctx.focusedEntity.kind !== 'StreamingText') {
    return {
      ok: false,
      reason: `unsupported-focused-entity-kind:${ctx.focusedEntity.kind}`,
    };
  }

  // Lazy import nut.js. The native module is heavy; we only pay for it
  // when the user actually presses Insert Tab.
  let keyboard: typeof import('@nut-tree-fork/nut-js').keyboard;
  try {
    const nut = (await import('@nut-tree-fork/nut-js')) as typeof import('@nut-tree-fork/nut-js');
    keyboard = nut.keyboard;
  } catch (err) {
    logger.error(
      'Insert Tab: nut.js load failed',
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      LogComponent.Orb,
    );
    return { ok: false, reason: 'nut-js-load-failed' };
  }

  try {
    await keyboard.type(text, { delayMs: TYPING_DELAY_MS } as never);
    logger.info(
      'Insert Tab success',
      {
        length: text.length,
        exeName: ctx.foreground.exeName,
      },
      LogComponent.Orb,
    );
    return { ok: true, method: 'nut.type', length: text.length };
  } catch (err) {
    logger.error(
      'Insert Tab: nut.type failed',
      err instanceof Error ? err : new Error(String(err)),
      { length: text.length },
      LogComponent.Orb,
    );
    return { ok: false, reason: 'nut-type-failed' };
  }
}

/**
 * Pure decision helper: given an OSContext, decide whether Insert
 * Tab is allowed. Exported so unit tests can exercise the matrix
 * without needing nut.js.
 */
export interface InsertTabDecision {
  ok: boolean;
  reason?: string;
}

export function decideInsertTab(
  ctx: { redacted: boolean; redactionReason: string | null; focusedEntity: { kind: string } | null } | null,
): InsertTabDecision {
  if (!ctx) return { ok: false, reason: 'no-os-context-snapshot' };
  if (ctx.redacted) return { ok: false, reason: 'focused-field-redacted' };
  if (!ctx.focusedEntity) return { ok: false, reason: 'no-focused-entity' };
  if (
    ctx.focusedEntity.kind !== 'Text' &&
    ctx.focusedEntity.kind !== 'StreamingText'
  ) {
    return {
      ok: false,
      reason: `unsupported-focused-entity-kind:${ctx.focusedEntity.kind}`,
    };
  }
  return { ok: true };
}