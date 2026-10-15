/** Compatibility adapter for the legacy Agent import path. */
import {
  UpdateStateTool as CapabilityUpdateStateTool,
  normalizeDedupeKey,
  resolveUpdateStateOperation,
} from '@duya/capabilities/UpdateStateTool/UpdateStateTool';
import type { ResolvedOperation, UpdateStateInput } from '@duya/capabilities/UpdateStateTool/UpdateStateTool';
import type {
  BotIdentityBridge,
  MemoryTierBridge,
  UpdateStatePort,
} from '@duya/capabilities/UpdateStateTool/ports';
import { createWorkerUpdateStatePort } from '@duya/host/worker-tool-services/update-state';

export { normalizeDedupeKey, resolveUpdateStateOperation };
export type { ResolvedOperation, UpdateStateInput };
export type {
  BotIdentityBridge,
  BotIdentityPatchPayload,
  MemoryTierBridge,
  MemoryTierBridgeResponse,
  MemoryTierWritePayload,
  UpdateStateContext,
  UpdateStatePort,
} from '@duya/capabilities/UpdateStateTool/ports';

let injectedMemoryBridge: MemoryTierBridge | null = null;
let injectedIdentityBridge: BotIdentityBridge | null = null;

function createCompatibilityPort(): UpdateStatePort {
  const hostPort = createWorkerUpdateStatePort();
  return {
    writeMemory(payload, context) {
      return injectedMemoryBridge
        ? injectedMemoryBridge(payload, context)
        : hostPort.writeMemory(payload, context);
    },
    updateIdentity(payload, context) {
      return injectedIdentityBridge
        ? injectedIdentityBridge(payload, context)
        : hostPort.updateIdentity(payload, context);
    },
  };
}

export class UpdateStateTool extends CapabilityUpdateStateTool {
  constructor(port: UpdateStatePort = createCompatibilityPort()) {
    super(port);
  }
}

/** Legacy test-hook exports remain on the compatibility path only. */
export function setMemoryTierBridge(bridge: MemoryTierBridge | null): void {
  injectedMemoryBridge = bridge;
}

export function setBotIdentityBridge(bridge: BotIdentityBridge | null): void {
  injectedIdentityBridge = bridge;
}

export const updateStateTool = new UpdateStateTool();
