/**
 * Runtime registration — wires the conductor into a host process.
 *
 * The conductor owns no transport and no global state on its own. The
 * host (the agent subprocess in production) calls `registerConductor`
 * once at startup to:
 *
 *   1. Register the `conductor` prompt system factory with the agent's
 *      prompt registry.
 *   2. Register the `conductor` prompt overlay patch.
 *   3. Register the canvas orchestrator tools with the agent's tool
 *      registry.
 *
 * The returned `unregister` function tears it back down (used in tests).
 *
 * Both `prompt` and `tools` registries are typed as **structural
 * interfaces** (duck-typed). The host supplies the concrete
 * `registerPromptSystem` / `registerOverlayPatch` / `registerBuiltInTool` /
 * `registerExecutor` callbacks. This keeps `@duya/conductor` from
 * reaching into agent internals — it can be driven from a different
 * host (tests, CLI, etc.) by passing different implementations.
 */

import {
  CANVAS_ORCHESTRATOR_TOOLS,
  getCanvasOrchestratorExecutors,
} from './tool/CanvasOrchestratorProfile.js';
import { ConductorPromptSystem } from './prompt/ConductorPromptSystem.js';
import { CONDUCTOR_PROMPT_PROFILE } from './prompt/conductor-prompt.js';
import type { PromptProfile } from '@duya/agent/prompts/modes/types';
import type { Tool } from '@duya/agent/types';
import type { ToolExecutor } from '@duya/agent/tool/registry';
import type { PromptSystem } from '@duya/agent/prompts';

/**
 * Minimal contract for the agent's prompt registry. The host supplies
 * the concrete `registerPromptSystem` and `registerOverlayPatch` calls.
 *
 * The factory's return type is `PromptSystem` (not `ConductorPromptSystem`)
 * so the callback is structurally compatible with any host that
 * expects a `PromptSystemFactory` whose `create` returns the
 * abstract `PromptSystem` type. The conductor's
 * `ConductorPromptSystem extends PromptSystem`, so a factory
 * returning `ConductorPromptSystem` is also returning a
 * `PromptSystem`.
 */
export interface ConductorPromptRegistry {
  /** Register a new prompt system under a name (e.g. 'conductor'). */
  registerPromptSystem: (
    name: string,
    factory: (profile?: PromptProfile) => PromptSystem,
  ) => void;
  /** Register / replace an overlay patch. */
  registerOverlayPatch?: (
    name: string,
    patch: { enable?: string[]; disable?: string[] },
  ) => void;
}

/**
 * Minimal contract for the agent's tool registry. The host supplies
 * the concrete `registerBuiltInTool` / `registerExecutor` calls.
 *
 * The signatures match `ToolRegistry.register(definition, executor)` —
 * the host can wire the callbacks directly to its own `register`
 * method. This is the path the agent subprocess uses when it wants
 * to defer tool registration to a host-supplied registry (e.g. tests
 * that don't want to use the global builtin registry).
 */
export interface ConductorToolRegistry {
  /** Register a built-in tool. */
  registerBuiltInTool?: (tool: Tool) => void;
  /** Register a tool executor paired with a tool definition. */
  registerExecutor?: (tool: Tool, executor: ToolExecutor) => void;
}

export interface ConductorRegistration {
  prompt?: ConductorPromptRegistry;
  tools?: ConductorToolRegistry;
  /** When true (default), the conductor's `'conductor'` prompt overlay is also registered. */
  registerOverlay?: boolean;
}

export interface ConductorRegistrationHandle {
  unregister: () => void;
}

export function registerConductor(deps: ConductorRegistration = {}): ConductorRegistrationHandle {
  const { prompt, tools, registerOverlay = true } = deps;

  // 1. Prompt system
  if (prompt?.registerPromptSystem) {
    prompt.registerPromptSystem('conductor', (profile) => new ConductorPromptSystem(profile));
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

  // 4. Tool executors — pair each tool definition with its executor
  // by name. `getCanvasOrchestratorExecutors()` returns a Record keyed
  // by tool name; we zip it with `CANVAS_ORCHESTRATOR_TOOLS` so the
  // executor registration in the host is `register(tool, executor)`.
  if (tools?.registerExecutor) {
    const executors = getCanvasOrchestratorExecutors();
    for (const tool of CANVAS_ORCHESTRATOR_TOOLS) {
      const executor = executors[tool.name];
      if (executor) {
        tools.registerExecutor(tool, executor);
      }
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
