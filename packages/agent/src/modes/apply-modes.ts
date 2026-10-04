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
 * Lifecycle: `onEnter` runs here (once per turn, for every resolved mode).
 * `onExit` is dispatched from the boundary that matches the mode's `kind` —
 * `runExitHooks` covers `kind: 'message'` modes at the run boundary, and
 * session modes are settled inside `applyModes` when they leave the
 * resolved set (see {@link sessionEntered}).
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

/**
 * Session-scoped lifecycle ledger: `sessionId` → the modifiers whose
 * `onEnter` has run for that session and which are still part of the last
 * resolved set.
 *
 * Why this exists: `onEnter` runs on EVERY turn (applyModes is per
 * streamChat), but the run-boundary dispatch {@link runExitHooks} only
 * reaches `kind: 'message'` modifiers. A session mode's `onExit` therefore
 * had no reachable call site at all — computer-use's
 * `OSContextBridge.disable()` and its sticky-trigger reset never ran.
 *
 * The ledger gives the session half of the lifecycle a real trigger: a
 * session mode that was active last turn and is absent from this turn's
 * resolved set has been toggled off (or displaced by an exclusive mode), so
 * its `onExit` is owed exactly once, before the new turn's `onEnter` hooks
 * run. A mode that is still active is left alone — it must keep its
 * resources between turns.
 */
const sessionEntered = new Map<string, ModeModifier[]>();

export async function applyModes(input: ApplyModesInput): Promise<ApplyModesResult> {
  const { basePrompt, baseTools, baseToolUseContext, ctx, resolved } = input;

  // 0. Session lifecycle: settle `onExit` for session modes that left the
  //    resolved set since the last turn on this session. Skipped for an
  //    empty sessionId — every id-less turn would share one ledger key and
  //    fire another session's exit hooks.
  const previousEntered = ctx.sessionId ? sessionEntered.get(ctx.sessionId) : undefined;
  if (ctx.sessionId) {
    if (resolved.modes.length > 0) {
      sessionEntered.set(ctx.sessionId, resolved.modes);
    } else {
      // Nothing active → nothing is owed; drop the entry so the map cannot
      // grow without bound across a long-lived worker.
      sessionEntered.delete(ctx.sessionId);
    }
  }
  if (previousEntered) {
    const stillActive = new Set(resolved.modes.map((mod) => mod.id));
    for (const mod of previousEntered) {
      if (mod.kind !== 'session' || stillActive.has(mod.id)) continue;
      const onExit = mod.hooks?.onExit;
      if (!onExit) continue;
      // Fail-open, mirroring runExitHooks: a failing exit hook must never
      // take the next turn down with it.
      try {
        await onExit(ctx);
      } catch {
        // Ignored on purpose — the mode is already deactivated.
      }
    }
  }

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
  //
  //    The declared `block` / `allow` filters are applied to the BASE
  //    profile tools in every case. `overrideFilter` does NOT mean "ignore
  //    block": per `ModeModifierTools` it only exempts a mode's OWN injected
  //    tools from profile filtering, so a mode can keep its canvas / research
  //    / goal tools under a restrictive base profile while still blocking
  //    write tools. The previous `if (overrideFilter)` branch skipped the
  //    filters entirely, and because `resolve()` ORs the flag across every
  //    active mode, goal+plan-task (goal declares `overrideFilter: true`,
  //    plan-task declares the write-tool `block` list) and research alone
  //    both advertised bash/edit/write to the model while the coordinator
  //    refused to run them.
  //
  //    Both halves are load-bearing and must not be collapsed:
  //    this list is what the model is BELIEVED it has, while the
  //    call-time check in `ModeCoordinator.gateWriteTool` is what actually
  //    refuses. A stale advertised list is a lie the model acts on; a
  //    missing call-time check is a hole. Keep both.
  const blocked = new Set(resolved.tools.blocked);
  let baseFiltered = baseTools.filter((t) => !blocked.has(t.definition.name));
  if (resolved.tools.allowed) {
    const allowSet = new Set(resolved.tools.allowed);
    // Injected tools are NOT subject to the allow-list — modes that inject
    // tools expect them to remain visible even under a tight whitelist. (If
    // a mode wants to also whitelist its own injections, it should not
    // declare `allow`.)
    baseFiltered = baseFiltered.filter((t) => allowSet.has(t.definition.name));
  }
  const tools: ToolRegistration[] = [...baseFiltered, ...injectedTools];

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
 * agent after the stream completes (success or abort).
 *
 * Session-level modes are deliberately NOT run here: a session mode is
 * still active after the run ends, and its `onExit` is about DEACTIVATION
 * (toggled off, or displaced by an exclusive mode) — running it at every run
 * boundary would tear down state the mode is still entitled to use (e.g.
 * computer-use would disable its OS context bridge and clear its sticky
 * triggers after every single message). Those modes are settled by
 * `applyModes` when they drop out of the resolved set.
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
