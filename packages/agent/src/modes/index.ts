import { modeModifierRegistry } from './registry.js';
import { researchMode } from './research-mode.js';
import { conductorMode } from './conductor-mode.js';
import { planTaskMode } from './plan-task-mode.js';
import { automationMode } from './automation-mode.js';

// Register declarative ModeModifiers (plan 224).
modeModifierRegistry.register(researchMode);
modeModifierRegistry.register(conductorMode);
modeModifierRegistry.register(planTaskMode);
modeModifierRegistry.register(automationMode);

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