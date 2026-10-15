/**
 * applyModes — apply a resolved set of ModeModifiers to a base profile.
 *
 * This is the single entry point used by `DuyaAgent.streamChat` (Phase
 * 2+ of plan 224). It:
 *   1. Runs `onEnter` hooks (modes may resolve canvasId, open sidebar…)
 *   2. Applies prompt prefixes/suffixes to the base system prompt
 *   3. Merges tool adjustments (inject / block / allow / overrideFilter)
 *   4. Merges `toolUseContextPatch` into the base ToolUseContext
 *   5. Runs `beforeStream` hooks and merges their StreamOptionsPatch
 *
 * `onExit` is NOT called here — it fires after the agent loop finishes
 * (only for `kind: 'message'` modes). Use {@link runExitHooks} for that.
 */

import type {
  ModeModifier,
  ModeModifierContext,
  ResolvedMode,
  StreamOptionsPatch,
  ToolRegistration,
} from './types.js';

export interface ApplyModesInput {
  /** Base system prompt from the agent profile (before mode overlays). */
  basePrompt: string;
  /** Base tool set from the agent profile. */
  baseTools: ToolRegistration[];
  /** Base ToolUseContext fields (e.g. sessionId, workingDirectory). */
  baseToolUseContext?: Record<string, unknown>;
  /** Mode runtime context. `state` may be pre-populated for session-level modes (e.g. conductorCanvasId from DB). */
  ctx: ModeModifierContext;
  /** Output of `ModeModifierRegistry.resolve(activeModeIds)`. */
  resolved: ResolvedMode;
}

export interface ApplyModesResult {
  systemPrompt: string;
  tools: ToolRegistration[];
  toolUseContext: Record<string, unknown>;
  streamOpts: StreamOptionsPatch;
  /** The (possibly mutated) context — `ctx.state` may have been updated by `onEnter` hooks. */
  ctx: ModeModifierContext;
}

export async function applyModes(input: ApplyModesInput): Promise<ApplyModesResult> {
  const { basePrompt, baseTools, baseToolUseContext, ctx, resolved } = input;

  // 1. Run onEnter hooks in registration order. Modes may mutate ctx.state
  //    and set ctx.toolUseContextPatch (e.g. conductor resolves canvasId).
  for (const mod of resolved.modes) {
    await mod.hooks?.onEnter?.(ctx);
  }

  // 2. Apply prompt prefixes / suffixes. Prefixes prepend (in registration
  //    order), suffixes append. Function-form entries get the current ctx.
  let systemPrompt = basePrompt;
  for (const prefix of resolved.prompt.prefixes) {
    systemPrompt =
      typeof prefix === 'function' ? prefix(ctx, systemPrompt) : prefix + systemPrompt;
  }
  for (const suffix of resolved.prompt.suffixes) {
    systemPrompt =
      typeof suffix === 'function' ? suffix(ctx, systemPrompt) : systemPrompt + suffix;
  }

  // 3. Evaluate function-form injects now that ctx is available, then merge.
  const injectedTools: ToolRegistration[] = [];
  for (const inject of resolved.tools.injects) {
    const items = typeof inject === 'function' ? inject(ctx) : inject;
    injectedTools.push(...items);
  }

  // 4. Compose final tool set.
  //    - overrideFilter=true: profile filtering is bypassed; injected tools
  //      are appended unconditionally. (Conductor needs this so canvas tools
  //      survive even under the `code` profile.)
  //    - otherwise: blocked tools are removed, allow-list is applied, then
  //      injected tools are appended.
  let tools: ToolRegistration[];
  if (resolved.tools.overrideFilter) {
    tools = [...baseTools, ...injectedTools];
  } else {
    const blocked = new Set(resolved.tools.blocked);
    let baseFiltered = baseTools.filter((t) => !blocked.has(t.definition.name));
    if (resolved.tools.allowed) {
      const allowSet = new Set(resolved.tools.allowed);
      // Injected tools are NOT subject to the allow-list — modes that
      // inject tools expect them to remain visible even under a tight
      // whitelist. (If a mode wants to also whitelist its own injections,
      // it should not declare `allow`.)
      baseFiltered = baseFiltered.filter((t) => allowSet.has(t.definition.name));
    }
    tools = [...baseFiltered, ...injectedTools];
  }

  // 5. Merge toolUseContextPatch from ctx. All onEnter hooks share the
  //    same ctx, so the final patch reflects whatever the last writer
  //    left in ctx.toolUseContextPatch. In practice modes write their
  //    own keys (conductor writes `conductorCanvasId`), so collision is
  //    not a concern.
  const toolUseContext: Record<string, unknown> = {
    ...(baseToolUseContext ?? {}),
    ...(ctx.toolUseContextPatch ?? {}),
  };

  // 6. Run beforeStream hooks. Each hook returns a partial patch; later
  //    modes override earlier ones on key collision.
  const streamOpts: StreamOptionsPatch = {};
  for (const mod of resolved.modes) {
    const patch = await mod.hooks?.beforeStream?.(ctx);
    if (patch) {
      Object.assign(streamOpts, patch);
    }
  }

  return { systemPrompt, tools, toolUseContext, streamOpts, ctx };
}

/**
 * Run `onExit` hooks for all `kind: 'message'` modes. Called by the
 * agent after the stream completes (success or abort). Session-level
 * modes are excluded — their onExit fires when the user toggles the
 * mode off, not after every message.
 */
export async function runExitHooks(
  resolved: ResolvedMode,
  ctx: ModeModifierContext,
): Promise<void> {
  for (const mod of resolved.modes) {
    if (mod.kind === 'message') {
      await mod.hooks?.onExit?.(ctx);
    }
  }
}

/**
 * Convenience helper: collect all active mode ids from a ChatOptions-like
 * object. Centralizes the `mode` + `conductorMode` → `activeModes[]`
 * translation so callers don't repeat the same if/else.
 *
 * Phase 2 of plan 224 wires this into `DuyaAgent.streamChat`. For now
 * it's exported but unused — kept here so the call site in Phase 2 is
 * a one-liner.
 */
export function collectActiveModes(options: {
  mode?: string;
  conductorMode?: boolean;
}): string[] {
  const ids: string[] = [];
  if (options.mode) ids.push(options.mode);
  if (options.conductorMode) ids.push('conductor');
  return ids;
}
