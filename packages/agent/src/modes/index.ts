import { modeModifierRegistry } from './registry.js';
import { researchMode } from './research-mode.js';
import { conductorMode } from './conductor-mode.js';
import { planTaskMode } from './plan-task-mode.js';
import { automationMode } from './automation-mode.js';
import { ModeTrackerEngine } from './engine/index.js';
import { planModeTracker } from './engine/plan-tracker.js';

// Register declarative ModeModifiers (plan 224).
modeModifierRegistry.register(researchMode);
modeModifierRegistry.register(conductorMode);
modeModifierRegistry.register(planTaskMode);
modeModifierRegistry.register(automationMode);

// Mode state-machine engine (plan 413a/413b). Trackers registered here
// are alive for the whole process and keep their state across streamChat
// calls. Plan 413d reads them via `modeTrackerEngine` to drive reminders,
// gating, and persistence.
export const modeTrackerEngine = new ModeTrackerEngine();
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