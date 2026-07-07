/**
 * ModeModifierRegistry — declarative mode registry (plan 224).
 *
 * Distinct from the legacy {@link ModeRegistry} in `index.ts`, which
 * handles `BaseMode` class instances (Research mode). This registry
 * handles {@link ModeModifier} declarative objects and supports
 * composable resolution via {@link resolve}.
 *
 * Migration: once Research mode is ported to ModeModifier (Phase 2 of
 * plan 224), the legacy `ModeRegistry` will be deleted and this file
 * becomes the single mode registry.
 */

import type {
  ModeModifier,
  ModeModifierContext,
  ResolvedMode,
  ToolRegistration,
} from './types.js';

export class ModeModifierRegistry {
  private modifiers = new Map<string, ModeModifier>();

  /**
   * Register a mode modifier. Throws if `mod.id` is already taken.
   * Idempotent across instances of the same modifier object.
   */
  register(mod: ModeModifier): void {
    if (this.modifiers.has(mod.id)) {
      throw new Error(`ModeModifier "${mod.id}" is already registered`);
    }
    this.modifiers.set(mod.id, mod);
  }

  has(id: string): boolean {
    return this.modifiers.has(id);
  }

  get(id: string): ModeModifier | undefined {
    return this.modifiers.get(id);
  }

  list(): ModeModifier[] {
    return [...this.modifiers.values()];
  }

  /**
   * Resolve one or more active mode ids into a merged {@link ResolvedMode}.
   *
   * Conflict resolution: if mode A's `exclusiveWith` lists mode B (or
   * vice versa), the *later* active id is dropped. The order of
   * `activeModeIds` is preserved — earlier ids win.
   *
   * Tool/prompt merging is purely declarative here — function-form
   * `tools.inject` entries are passed through unevaluated (no ctx
   * available). {@link applyModes} evaluates them later.
   */
  resolve(activeModeIds: readonly string[]): ResolvedMode {
    const resolved = this.resolveConflicts(activeModeIds);

    const injects: ResolvedMode['tools']['injects'] = [];
    const blocked = new Set<string>();
    let allowed: Set<string> | null = null;
    let overrideFilter = false;

    for (const mod of resolved) {
      const tools = mod.tools;
      if (!tools) continue;

      if (tools.inject) {
        injects.push(tools.inject);
      }
      if (tools.block) {
        for (const name of tools.block) blocked.add(name);
      }
      if (tools.allow) {
        const allowList = tools.allow;
        if (allowed) {
          // Intersect: keep only items present in both sets.
          const next = new Set<string>();
          for (const name of allowList) {
            if (allowed.has(name)) next.add(name);
          }
          allowed = next;
        } else {
          allowed = new Set(allowList);
        }
      }
      if (tools.overrideFilter) {
        overrideFilter = true;
      }
    }

    const prefixes = resolved
      .filter((m) => m.prompt?.prefix !== undefined)
      .map((m) => m.prompt!.prefix!) as Array<string | ((ctx: ModeModifierContext, base: string) => string)>;
    const suffixes = resolved
      .filter((m) => m.prompt?.suffix !== undefined)
      .map((m) => m.prompt!.suffix!) as Array<string | ((ctx: ModeModifierContext, base: string) => string)>;

    return {
      modes: resolved,
      tools: {
        injects,
        blocked: [...blocked],
        allowed: allowed ? [...allowed] : null,
        overrideFilter,
      },
      prompt: { prefixes, suffixes },
    };
  }

  /**
   * Filter `activeModeIds` by `exclusiveWith`. Earlier ids win — if A
   * is already in the result and A.exclusiveWith includes B (or
   * B.exclusiveWith includes A), B is skipped.
   *
   * Unknown ids are silently dropped (they may be stale references from
   * a previous app version or per-message state).
   */
  private resolveConflicts(activeModeIds: readonly string[]): ModeModifier[] {
    const result: ModeModifier[] = [];
    const resultIds = new Set<string>();

    for (const id of activeModeIds) {
      const mod = this.modifiers.get(id);
      if (!mod) continue;

      const conflicts = result.some(
        (r) =>
          r.exclusiveWith?.includes(mod.id) ||
          mod.exclusiveWith?.includes(r.id),
      );
      if (conflicts) continue;

      result.push(mod);
      resultIds.add(mod.id);
    }

    return result;
  }

  /**
   * Helper for tests / debugging: evaluate all injects against a ctx and
   * return the flat tool list. Not used by the runtime — `applyModes`
   * does this inline.
   */
  evaluateInjects(
    resolved: ResolvedMode,
    ctx: ModeModifierContext,
  ): ToolRegistration[] {
    const out: ToolRegistration[] = [];
    for (const inject of resolved.tools.injects) {
      const items = typeof inject === 'function' ? inject(ctx) : inject;
      out.push(...items);
    }
    return out;
  }
}

/**
 * Singleton instance. Mode authors register their {@link ModeModifier}
 * objects against this in `packages/agent/src/modes/index.ts`.
 *
 * NOTE: named `modeModifierRegistry` to avoid colliding with the legacy
 * `ModeRegistry` singleton from `index.ts`. Will be renamed to
 * `modeRegistry` once the legacy registry is removed.
 */
export const modeModifierRegistry = new ModeModifierRegistry();
