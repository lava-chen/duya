import { randomBytes, randomUUID } from 'node:crypto';
import type {
  HostPluginAppInvocationApiV1,
  PluginAppInvocationBindInput,
  PluginAppInvocationBinding,
  PluginAppInvocationInput,
  PluginAppInvocationResult,
  PluginAppInstanceRecord,
  PluginAppMcpDescriptor,
} from '@duya/agent-protocol';
import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';
import type { SessionServiceCaller } from './session-service.js';

export interface HostPluginAppInvocationAuthority {
  resolveApp(pluginId: string, appId: string): Promise<PluginAppDefinition | null>;
  resolveGrantedCapabilities(input: {
    pluginId: string;
    appId: string;
    instanceId: string;
    sessionId: string;
    runId: string;
  }): Promise<readonly string[] | null>;
  /** Return a capability only for an exact canonical descriptor mapping. */
  resolveToolCapability(input: {
    pluginId: string;
    app: PluginAppDefinition;
    descriptor: Readonly<Record<string, string>>;
  }): string | null;
}

export interface HostPluginAppInvocationWorker {
  describeMcpTools(input: { sessionId: string; runId: string; epoch: number }): Promise<readonly PluginAppMcpDescriptor[]>;
  invokeMcpTool(input: {
    sessionId: string;
    runId: string;
    epoch: number;
    bindingId: string;
    nonce: string;
    toolId: string;
    schemaRevision: string;
    capabilityId: string;
    arguments: Record<string, unknown>;
    requestId: string;
  }): Promise<PluginAppInvocationResult>;
}

export interface HostPluginAppInvocationOptions {
  getInstance(instanceId: string): Promise<PluginAppInstanceRecord | null>;
  readonly authority?: HostPluginAppInvocationAuthority;
  readonly worker?: HostPluginAppInvocationWorker;
  currentRun(sessionId: string): Promise<{ readonly runId: string; readonly epoch: number } | null>;
  isCurrentRun(sessionId: string, runId: string, epoch: number): Promise<boolean>;
}

export interface HostPluginAppInvocationInternalApi extends HostPluginAppInvocationApiV1 {
  /** Worker-only final side-effect fence; caller identity is derived by RunExecution. */
  isBindingCurrent(bindingId: string, nonce: string, toolId: string, caller: SessionServiceCaller): Promise<boolean>;
}

interface StoredBinding extends PluginAppInvocationBinding {
  readonly epoch: number;
  readonly expiresAt: number;
  readonly grantedCapabilities: readonly string[];
  readonly tools: ReadonlyMap<string, { descriptor: PluginAppMcpDescriptor; capabilityId: string }>;
}

export class HostPluginAppInvocationApiError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503) {
    super(code);
    this.name = 'HostPluginAppInvocationApiError';
  }
}

function reject(code: string, status: 400 | 404 | 409 | 503): never {
  throw new HostPluginAppInvocationApiError(code, status);
}

function fail(code: string, message: string): PluginAppInvocationResult {
  return { ok: false, code, message };
}

/** Host-owned ephemeral binding table. No authority is accepted from invoke input. */
export function createHostPluginAppInvocationApi(
  options: HostPluginAppInvocationOptions,
): HostPluginAppInvocationInternalApi {
  const bindings = new Map<string, StoredBinding>();
  return {
    async bindPluginAppInvocation(input: PluginAppInvocationBindInput): Promise<PluginAppInvocationBinding> {
      const { authority, worker } = options;
      if (!authority || !worker) reject('plugin_app_invocation_authority_unavailable', 503);
      const now = Date.now();
      for (const [id, stored] of bindings) {
        if (now >= stored.expiresAt) bindings.delete(id);
      }
      const instance = await options.getInstance(input.instanceId);
      if (!instance || instance.pluginId !== input.pluginId || instance.appId !== input.appId || instance.status !== 'active') {
        reject('plugin_app_instance_unavailable', 404);
      }
      const app = await authority.resolveApp(input.pluginId, input.appId);
      if (!app || app.appId !== instance.appId || app.stateSchemaVersion !== instance.stateSchemaVersion) {
        reject('plugin_app_manifest_mismatch', 409);
      }
      const run = await options.currentRun(input.sessionId);
      if (!run || !(await options.isCurrentRun(input.sessionId, run.runId, run.epoch))) {
        reject('plugin_app_session_not_running', 409);
      }
      const grantedCapabilities = await authority.resolveGrantedCapabilities({
        pluginId: input.pluginId,
        appId: input.appId,
        instanceId: input.instanceId,
        sessionId: input.sessionId,
        runId: run.runId,
      });
      if (!grantedCapabilities) reject('plugin_app_grant_authority_unavailable', 503);
      const descriptors = await worker.describeMcpTools({ sessionId: input.sessionId, ...run });
      const tools = new Map<string, { descriptor: PluginAppMcpDescriptor; capabilityId: string }>();
      for (const descriptor of descriptors) {
        const capabilityId = authority.resolveToolCapability({
          pluginId: input.pluginId,
          app,
          descriptor: descriptor.descriptor,
        });
        if (capabilityId && app.requiredCapabilities.includes(capabilityId) && grantedCapabilities.includes(capabilityId)) {
          if (tools.has(descriptor.toolId)) reject('plugin_app_tool_identity_ambiguous', 409);
          tools.set(descriptor.toolId, { descriptor, capabilityId });
        }
      }
      const binding: StoredBinding = {
        bindingId: randomUUID(),
        nonce: randomBytes(32).toString('base64url'),
        pluginId: input.pluginId,
        appId: input.appId,
        instanceId: instance.instanceId,
        sessionId: input.sessionId,
        runId: run.runId,
        stateSchemaVersion: app.stateSchemaVersion,
        epoch: run.epoch,
        expiresAt: now + 5 * 60 * 1000,
        grantedCapabilities: [...grantedCapabilities],
        tools,
      };
      bindings.set(binding.bindingId, binding);
      const { epoch: _epoch, expiresAt: _expiresAt, grantedCapabilities: _grants, tools: _tools, ...publicBinding } = binding;
      return publicBinding;
    },
    async invokePluginAppTool(input: PluginAppInvocationInput): Promise<PluginAppInvocationResult> {
      const binding = bindings.get(input.bindingId);
      if (!binding || binding.nonce !== input.nonce || Date.now() >= binding.expiresAt) {
        if (binding) bindings.delete(binding.bindingId);
        return fail('binding_invalid', 'The Plugin App binding is invalid or expired.');
      }
      const { authority, worker } = options;
      if (!authority || !worker) return fail('authority_unavailable', 'Plugin App invocation authority is unavailable.');
      if (!(await options.isCurrentRun(binding.sessionId, binding.runId, binding.epoch))) {
        bindings.delete(binding.bindingId);
        return fail('attempt_fenced', 'The bound session run is no longer active.');
      }
      const instance = await options.getInstance(binding.instanceId);
      if (!instance || instance.status !== 'active' || instance.revision < 1 ||
          instance.pluginId !== binding.pluginId || instance.appId !== binding.appId ||
          instance.stateSchemaVersion !== binding.stateSchemaVersion) {
        bindings.delete(binding.bindingId);
        return fail('instance_inactive', 'The bound Plugin App instance is no longer active.');
      }
      const tool = binding.tools.get(input.toolId);
      if (!tool) return fail('tool_unavailable', 'The requested tool is not authorized for this binding.');
      const app = await authority.resolveApp(binding.pluginId, binding.appId);
      if (!app || app.stateSchemaVersion !== binding.stateSchemaVersion ||
          !app.requiredCapabilities.includes(tool.capabilityId) ||
          authority.resolveToolCapability({
            pluginId: binding.pluginId,
            app,
            descriptor: tool.descriptor.descriptor,
          }) !== tool.capabilityId) {
        bindings.delete(binding.bindingId);
        return fail('manifest_mismatch', 'The trusted Plugin App manifest or tool mapping changed.');
      }
      const currentGrants = await authority.resolveGrantedCapabilities({
        pluginId: binding.pluginId,
        appId: binding.appId,
        instanceId: binding.instanceId,
        sessionId: binding.sessionId,
        runId: binding.runId,
      });
      if (!currentGrants || !currentGrants.includes(tool.capabilityId)) {
        bindings.delete(binding.bindingId);
        return fail('capability_revoked', 'The Plugin App capability is no longer granted.');
      }
      if (!(await options.isCurrentRun(binding.sessionId, binding.runId, binding.epoch))) {
        bindings.delete(binding.bindingId);
        return fail('attempt_fenced', 'The bound session run changed before invocation.');
      }
      return worker.invokeMcpTool({
        sessionId: binding.sessionId,
        runId: binding.runId,
        epoch: binding.epoch,
        bindingId: binding.bindingId,
        nonce: binding.nonce,
        toolId: input.toolId,
        schemaRevision: tool.descriptor.schemaRevision,
        capabilityId: tool.capabilityId,
        arguments: input.arguments,
        requestId: input.requestId ?? randomUUID(),
      });
    },
    async revokePluginAppInvocation(bindingId: string, nonce: string): Promise<boolean> {
      const binding = bindings.get(bindingId);
      if (!binding || binding.nonce !== nonce) return false;
      bindings.delete(bindingId);
      return true;
    },
    async isBindingCurrent(bindingId: string, nonce: string, toolId: string, caller: SessionServiceCaller): Promise<boolean> {
      const binding = bindings.get(bindingId);
      if (!binding || binding.nonce !== nonce || Date.now() >= binding.expiresAt || !options.authority ||
          caller.sessionId !== binding.sessionId || caller.runId !== binding.runId || caller.epoch !== binding.epoch) {
        return false;
      }
      if (!(await options.isCurrentRun(binding.sessionId, binding.runId, binding.epoch))) return false;
      const instance = await options.getInstance(binding.instanceId);
      if (!instance || instance.status !== 'active' || instance.pluginId !== binding.pluginId ||
          instance.appId !== binding.appId || instance.stateSchemaVersion !== binding.stateSchemaVersion) return false;
      const app = await options.authority.resolveApp(binding.pluginId, binding.appId);
      if (!app || app.stateSchemaVersion !== binding.stateSchemaVersion) return false;
      const grants = await options.authority.resolveGrantedCapabilities({
        pluginId: binding.pluginId,
        appId: binding.appId,
        instanceId: binding.instanceId,
        sessionId: binding.sessionId,
        runId: binding.runId,
      });
      const tool = binding.tools.get(toolId);
      return grants !== null && tool !== undefined && app.appId === binding.appId &&
        app.requiredCapabilities.includes(tool.capabilityId) && grants.includes(tool.capabilityId) &&
        options.authority.resolveToolCapability({
          pluginId: binding.pluginId,
          app,
          descriptor: tool.descriptor.descriptor,
        }) === tool.capabilityId;
    },
  };
}
