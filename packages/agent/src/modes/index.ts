import { modeModifierRegistry } from './registry.js';
import { researchMode } from './research-mode.js';
import { conductorMode } from './conductor-mode.js';
import { planTaskMode } from './plan-task-mode.js';
import { automationMode } from './automation-mode.js';
import { goalMode } from './goal-mode.js';
import { ModeTrackerEngine } from './engine/index.js';
import { planModeTracker } from './engine/plan-tracker.js';
import { goalModeTracker } from './engine/goal-tracker.js';
import type { ModeTracker } from './engine/tracker.js';

// Register declarative ModeModifiers (plan 224).
modeModifierRegistry.register(researchMode);
modeModifierRegistry.register(conductorMode);
modeModifierRegistry.register(planTaskMode);
modeModifierRegistry.register(automationMode);
modeModifierRegistry.register(goalMode);

// Mode state-machine engine (plan 413a/413b). Trackers registered here
// are alive for the whole process and keep their state across streamChat
// calls. Plan 413d reads them via `modeTrackerEngine` to drive reminders,
// gating, and persistence.
export const modeTrackerEngine = new ModeTrackerEngine();
modeTrackerEngine.register(planModeTracker);
// Goal events carry payloads (objects), unlike plan's string events, so
// the narrowed tracker needs an explicit upcast to the engine's
// `ModeTracker<string, string, unknown>` existential. The engine only
// calls state()/snapshot()/restore() — never transition() — so the cast
// is safe (same contract the 413a engine doc allows for upcasting).
modeTrackerEngine.register(goalModeTracker as unknown as ModeTracker<string, string, unknown>);

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