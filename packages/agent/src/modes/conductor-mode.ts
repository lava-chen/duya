/**
 * Conductor mode modifier (plan 224 Phase 3).
 *
 * Declares the canvas-conductor overlay as a {@link ModeModifier} in
 * modifier paradigm: it injects the 11 canvas tools, bypasses profile
 * filtering (so canvas tools survive even under the `code` profile),
 * prepends the conductor prompt, and surfaces `conductorCanvasId`
 * through `toolUseContextPatch` so every canvas tool sees it without
 * the LLM having to pass it.
 *
 * Migration status (2026-07-06): the previous inline implementation in
 * `DuyaAgent.streamChat` (tool injection in `builtin.ts`, tool-reinstate
 * after profile filter, prompt prefix, canvasId injection in
 * ToolUseContext) is replaced by this declarative modifier. The
 * frontend still pre-resolves `conductorCanvasId` (4-level priority)
 * to open the sidebar panel and passes it via `ChatOptions.conductorCanvasId`;
 * `streamChat` copies it into `ctx.state.conductorCanvasId` before
 * `applyModes` runs, and `onEnter` lifts it onto `toolUseContextPatch`.
 *
 * Per-turn prompt refresh: `streamChat` re-evaluates `prompt.prefix`
 * each turn with the latest `widgetStyleHistory` so the anti-slop
 * section stays current as canvas tools push new style signatures
 * during the stream.
 */

import type { ModeModifier, ModeModifierContext } from './types.js';
import { getCanvasConductorTools } from '../tool/CanvasConductor/index.js';
import { buildConductorPrompt } from '../tool/CanvasConductor/prompt.js';
import type { WidgetStyleSignature } from '../types.js';

/**
 * Build the conductor prompt prefix from the current mode context.
 *
 * `ctx.state.widgetStyleHistory` is populated by `streamChat` from the
 * agent's rolling `widgetStyleHistory` field. Re-evaluated each turn
 * so newly pushed style signatures appear in the anti-slop section.
 */
function buildConductorPrefix(ctx: ModeModifierContext): string {
  const history = ctx.state.widgetStyleHistory as WidgetStyleSignature[] | undefined;
  return buildConductorPrompt(history);
}

/**
 * Conductor mode modifier — session-level, composes with `research`,
 * mutually exclusive with `plan-task`.
 */
export const conductorMode: ModeModifier = {
  id: 'conductor',
  kind: 'session',
  exclusiveWith: ['plan-task'],
  display: { label: 'Conductor 画布', icon: 'SquareHalf' },

  tools: {
    // 11 canvas tools (create / batch / delete / move / resize / fill /
    // style / list / find-empty-space / capture / get-knowledge).
    inject: () => getCanvasConductorTools(),
    // Canvas tools are gated by the session toggle, not by the agent
    // profile. Re-instate any canvas tools that a profile may have
    // filtered out so the model always sees them when conductor mode
    // is on.
    overrideFilter: true,
  },

  prompt: {
    // Prepended last (after profile identity) so it appears first and
    // the model sees tool instructions + anti-slop history before the
    // base prompt.
    prefix: buildConductorPrefix,
  },

  hooks: {
    // Lift conductorCanvasId (pre-resolved by the frontend and passed
    // via ChatOptions.conductorCanvasId → ctx.state.conductorCanvasId)
    // onto toolUseContextPatch so every canvas tool reads it from
    // ToolUseContext without the LLM passing it explicitly.
    onEnter: (ctx: ModeModifierContext) => {
      const canvasId = ctx.state.conductorCanvasId as string | undefined;
      if (canvasId) {
        ctx.toolUseContextPatch = {
          ...(ctx.toolUseContextPatch ?? {}),
          conductorCanvasId: canvasId,
        };
      }
    },
  },

  persist: {
    serialize: (ctx) => ({ canvasId: ctx.state.conductorCanvasId }),
    deserialize: (raw) => {
      const data = raw as { canvasId?: string } | null | undefined;
      return { conductorCanvasId: data?.canvasId };
    },
  },
};
