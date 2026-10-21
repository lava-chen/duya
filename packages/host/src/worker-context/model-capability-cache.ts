import { createModelCapabilityDetector } from './model-capability-probe.js';
import { modelCapabilityDb } from '../worker-db-client.js';
import type { ModelCapabilityRecord } from '@duya/agent-protocol/model-capabilities';
export type { ProbeConfig } from './model-capability-probe.js';
/** Bind probing to the existing worker IPC cache API; database handles stay outside the worker. */
export const detectModelCapability = createModelCapabilityDetector({
  async getModelCapability(modelName) { return await modelCapabilityDb.get(modelName) as ModelCapabilityRecord | null; },
  async setModelCapability(input) {
    await modelCapabilityDb.set(input.modelName, input.isMultimodal, input.method ?? 'unknown');
    return { success: true };
  },
});
