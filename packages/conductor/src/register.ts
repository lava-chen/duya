/**
 * Runtime registration — wires the conductor into a host process.
 *
 * The conductor owns no transport and no global state on its own. The
 * host (the agent subprocess in production) calls `registerConductor`
 * once at startup to:
 *
 *   1. Register the `conductor` prompt system factory with the agent's
 *      prompt registry.
 *   2. Register the canvas orchestrator tools with the agent's tool
 *      registry.
 *
 * The returned `unregister` function tears it back down (used in tests).
 */

import {
  CANVAS_ORCHESTRATOR_TOOLS,
  getCanvasOrchestratorExecutors,
} from './tool/CanvasOrchestratorProfile.js';
import { ConductorPromptSystem } from './prompt/ConductorPromptSystem.js';
import { CONDUCTOR_PROMPT_PROFILE } from './prompt/conductor-prompt.js';

/**
 * Minimal contract for the agent's prompt registry. The host supplies
 * the concrete `registerPromptSystem` and `registerOverlayPatch` calls.
 * Defining this as a structural type keeps `@duya/conductor` decoupled
 * from the agent's internal registry implementation.
 */
export interface ConductorPromptRegistry {
  /** Register a new prompt system under a name (e.g. 'conductor'). */
  registerPromptSystem: (name: string, factory: (profile?: unknown) => unknown) => void;
  /** Register / replace an overlay patch. */
  registerOverlayPatch?: (
    name: string,
    patch: { enable?: string[]; disable?: string[] },
  ) => void;
}

/**
 * Minimal contract for the agent's tool registry. The host supplies
 * the concrete `registerBuiltInTool` / `registerExecutor` calls.
 */
export interface ConductorToolRegistry {
  /** Register a built-in tool. The exact signature matches `tool/builtin.ts`. */
  registerBuiltInTool?: (tool: unknown) => void;
  /** Register a tool executor that runs after the registry's static tools. */
  registerExecutor?: (tool: unknown, executor: (input: unknown, context: unknown) => Promise<unknown>) => void;
}

export interface ConductorRegistration {
  prompt?: ConductorPromptRegistry;
  tools?: ConductorToolRegistry;
  /** When true, the conductor's `'conductor'` prompt overlay is also registered. */
  registerOverlay?: boolean;
}

export interface ConductorRegistrationHandle {
  unregister: () => void;
}

export function registerConductor(deps: ConductorRegistration = {}): ConductorRegistrationHandle {
  const { prompt, tools, registerOverlay = true } = deps;

  // 1. Prompt system
  if (prompt?.registerPromptSystem) {
    prompt.registerPromptSystem('conductor', () => new ConductorPromptSystem());
  }

  // 2. Overlay patch — opt-in
  if (registerOverlay && prompt?.registerOverlayPatch) {
    prompt.registerOverlayPatch('conductor', {
      enable: ['conductorCanvas'],
      disable: ['taskHandling', 'agentsMd'],
    });
  }

  // 3. Tool definitions
  if (tools?.registerBuiltInTool) {
    for (const tool of CANVAS_ORCHESTRATOR_TOOLS) {
      tools.registerBuiltInTool(tool);
    }
  }

  // 4. Tool executors
  if (tools?.registerExecutor) {
    for (const entry of getCanvasOrchestratorExecutors()) {
      tools.registerExecutor(entry.tool, entry.execute);
    }
  }

  return {
    unregister: () => {
      // No-op for now. Phase 7 will wire the actual unregister callbacks
      // once the host registries expose removal APIs.
    },
  };
}

export { CONDUCTOR_PROMPT_PROFILE };
