import {
  buildPermissions as buildRuntimePermissions,
  type PermissionsGateDeps as RuntimeGateDeps,
  type PermissionTurn,
} from '@duya/agent-runtime/authorization/permission-gate';
import type { ToolRegistry } from '@duya/host/worker-tool-registry';
import { logger } from '@duya/host/worker-logger';
export type { BuiltPermissions } from '@duya/agent-runtime/authorization/permission-gate';
export type PermissionsGateDeps = Omit<RuntimeGateDeps, 'warn'>;

export function buildPermissions(deps: PermissionsGateDeps, turn: PermissionTurn, registry?: ToolRegistry) {
  // Preserve prototype methods and getters on session objects such as DuyaAgent.
  const runtimeDeps: RuntimeGateDeps = {
    getPermissionMode: () => deps.getPermissionMode(),
    alwaysAllowRules: deps.alwaysAllowRules,
    alwaysDenyRules: deps.alwaysDenyRules,
    alwaysAskRules: deps.alwaysAskRules,
    additionalWorkingDirectories: deps.additionalWorkingDirectories,
    ...(deps.defaultWorkspaceDirectory === undefined ? {} : { defaultWorkspaceDirectory: deps.defaultWorkspaceDirectory }),
    ...(deps.hostToolPermission === undefined ? {} : { hostToolPermission: deps.hostToolPermission }),
    getAbortController: () => deps.getAbortController(),
    llmClient: deps.llmClient,
    model: deps.model,
    getMessages: () => deps.getMessages(),
    hasPermissionsToUseTool: (name, input, context) => deps.hasPermissionsToUseTool(name, input, context),
    getModeCoordinator: () => deps.getModeCoordinator(),
    warn: (message, metadata) => logger.warn(message, metadata),
  };
  return buildRuntimePermissions(runtimeDeps, turn, registry);
}

/** Legacy assembly delegates enforcement and per-invocation decisions to Runtime. */
export class PermissionsGate {
  constructor(private readonly deps: PermissionsGateDeps) {}
  build(turn: PermissionTurn, registry?: ToolRegistry) {
    return buildPermissions(this.deps, turn, registry);
  }
}
