import { modeModifierRegistry } from './registry.js';
import { researchMode } from './research-mode.js';
import { conductorMode } from './conductor-mode.js';
import { planTaskMode } from './plan/plan-task-mode.js';
import { automationMode } from './automation-mode.js';
import { goalMode } from './goal/goal-mode.js';
import { modeTrackerEngine } from '@duya/host/worker-modes/modifiers/index';
import type {
  ModeModifier,
  ModeModifierContext,
  ModeModifierDisplay,
  ModeModifierHooks,
  ModeModifierOrchestrator,
  ModeModifierPersist,
  ModeModifierPrompt,
  ModeModifierTools,
  OrchestratorDeps,
  PromptBuilder,
  ResolvedMode,
  SSEEvent,
  StreamOptionsPatch,
  ToolRegistration,
} from './types.js';

for (const mode of [
  researchMode,
  conductorMode,
  planTaskMode,
  automationMode,
  goalMode,
]) {
  modeModifierRegistry.register(mode);
}

export { modeModifierRegistry, modeTrackerEngine };
export type {
  ModeModifier,
  ModeModifierContext,
  ModeModifierDisplay,
  ModeModifierHooks,
  ModeModifierOrchestrator,
  ModeModifierPersist,
  ModeModifierPrompt,
  ModeModifierTools,
  OrchestratorDeps,
  PromptBuilder,
  ResolvedMode,
  SSEEvent,
  StreamOptionsPatch,
  ToolRegistration,
};
