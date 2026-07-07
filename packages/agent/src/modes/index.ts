import type { BaseMode, ModeConstructor } from './types.js';
import { modeModifierRegistry } from './registry.js';
import { researchMode } from './research-mode.js';
import { conductorMode } from './conductor-mode.js';
import { planTaskMode } from './plan-task-mode.js';

// ─── Register declarative ModeModifiers (plan 224) ──────────────
// Orchestrator-paradigm modes (research) and modifier-paradigm modes
// (conductor, plan-task) all share the single modeModifierRegistry.
// Legacy `ModeRegistry` (BaseMode class instances) is retained below
// for backward compatibility during the migration, but Research mode
// no longer registers there.
modeModifierRegistry.register(researchMode);
modeModifierRegistry.register(conductorMode);
modeModifierRegistry.register(planTaskMode);

class ModeRegistryImpl {
  private modes = new Map<string, ModeConstructor>();

  register(modeId: string, ctor: ModeConstructor): void {
    if (this.modes.has(modeId)) {
      throw new Error(`Mode "${modeId}" is already registered`);
    }
    this.modes.set(modeId, ctor);
  }

  create(modeId: string): BaseMode {
    const ctor = this.modes.get(modeId);
    if (!ctor) {
      throw new Error(
        `Mode "${modeId}" not found. Registered modes: ${[...this.modes.keys()].join(', ') || 'none'}`
      );
    }
    return new ctor();
  }

  has(modeId: string): boolean {
    return this.modes.has(modeId);
  }

  list(): string[] {
    return [...this.modes.keys()];
  }

  reset(): void {
    this.modes.clear();
  }
}

/**
 * Legacy mode registry for {@link BaseMode} class instances.
 *
 * @deprecated As of plan 224, modes register declarative {@link ModeModifier}
 * objects against {@link modeModifierRegistry} instead. This registry is
 * retained for backward compatibility but has no registrations — Research
 * mode migrated to `modeModifierRegistry` in Phase 2 of plan 224.
 */
export const ModeRegistry = new ModeRegistryImpl();

export { BaseMode } from './types.js';
export type { ModeContext, ModeConstructor, ClarificationQuestion, ClarificationAnswer } from './types.js';
export { modeModifierRegistry } from './registry.js';
export type {
  ModeModifier,
  ModeModifierContext,
  ModeModifierDisplay,
  ModeModifierHooks,
  ModeModifierPersist,
  ModeModifierPrompt,
  ModeModifierTools,
  ModeModifierOrchestrator,
  OrchestratorDeps,
  ResolvedMode,
  StreamOptionsPatch,
  ToolRegistration,
  PromptBuilder,
} from './types.js';