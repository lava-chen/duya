import { modeModifierRegistry } from './registry.js';
import { modeTrackerEngine, planModeTracker } from './engine/index.js';
import { researchMode } from './research-mode.js';
import { conductorMode } from './conductor-mode.js';
import { planTaskMode } from './plan-task-mode.js';
import { automationMode } from './automation-mode.js';

// Register declarative ModeModifiers (plan 224).
modeModifierRegistry.register(researchMode);
modeModifierRegistry.register(conductorMode);
modeModifierRegistry.register(planTaskMode);
modeModifierRegistry.register(automationMode);

// Register stateful-mode trackers with the engine (plan 413b). Plan-task is
// the first concrete tracker; goal/automation land in later plans.
modeTrackerEngine.register(planModeTracker);

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