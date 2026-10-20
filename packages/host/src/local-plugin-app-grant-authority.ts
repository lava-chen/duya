import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';
import {
  pluginAppCapabilityMappingExpands,
  pluginAppCapabilityTools,
} from '@duya/plugin-core/apps/declarations';
import { pluginIdFromScopedName, unscopedServerName } from '@duya/plugin-core';
import type { PluginAppGrantStore } from '@duya/data/plugin-app-grant-store';
import { computePluginAppMappingRevision } from './local-plugin-app-grant-api.js';
import type { HostPluginAppInvocationAuthority } from './local-plugin-app-invocation-api.js';

export interface HostPluginAppGrantAuthorityOptions {
  /** The durable grant ledger; the only record of a user's approval. */
  readonly store: PluginAppGrantStore;
  /**
   * Trusted installed-manifest resolution. The manifest is what the user was
   * shown, so it is the only thing a grant may be compared against.
   */
  resolveApp(
    pluginId: string,
    appId: string,
  ): Promise<PluginAppDefinition | null> | PluginAppDefinition | null;
}

/** The plugin that owns one live MCP descriptor, when it can be proven. */
function descriptorPluginId(descriptor: Readonly<Record<string, string>>): string | undefined {
  const declared = descriptor.pluginId;
  const serverName = descriptor.serverName;
  if (typeof serverName !== 'string' || serverName.length === 0) return undefined;
  const scopedOwner = pluginIdFromScopedName(serverName);
  if (typeof declared === 'string' && declared.length > 0) {
    return scopedOwner !== undefined && scopedOwner !== declared ? undefined : declared;
  }
  return scopedOwner;
}

/**
 * Whether a manifest-declared server name addresses the same live server.
 *
 * The manifest declares the raw MCP server name the plugin owns; a live
 * descriptor may carry either that raw name or the plugin-scoped form.
 */
function serverMatches(declared: string, actual: string): boolean {
  return declared === actual || declared === unscopedServerName(actual);
}

/**
 * The one capability whose declared mapping covers the descriptor.
 *
 * A tool claimed by two capabilities is ambiguous, and an ambiguous mapping
 * is refused rather than resolved by declaration order.
 */
function coveringCapability(
  app: PluginAppDefinition,
  descriptor: Readonly<Record<string, string>>,
): string | null {
  const serverName = descriptor.serverName;
  const toolName = descriptor.toolName;
  if (typeof serverName !== 'string' || serverName.length === 0) return null;
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  const capabilities: string[] = [];
  for (const mapping of app.capabilityTools ?? []) {
    if (!app.requiredCapabilities.includes(mapping.capability)) continue;
    const covers = mapping.tools.some(
      (tool) => tool.toolName === toolName && serverMatches(tool.serverName, serverName),
    );
    if (covers) capabilities.push(mapping.capability);
  }
  return capabilities.length === 1 ? capabilities[0]! : null;
}

/**
 * Resolve one live MCP descriptor to the capability that covers it.
 *
 * The grant must exist, must not be revoked, and must still describe the
 * scope the manifest declares now. The stored mapping revision is the digest
 * of that scope at approval time, so a digest mismatch means the manifest
 * moved after the user approved it and the grant no longer applies.
 */
function resolveToolCapabilityFromGrants(
  store: PluginAppGrantStore,
  pluginId: string,
  app: PluginAppDefinition,
  descriptor: Readonly<Record<string, string>>,
): string | null {
  if (descriptor.source !== 'plugin') return null;
  if (descriptorPluginId(descriptor) !== pluginId) return null;
  const serverName = descriptor.serverName;
  const toolName = descriptor.toolName;
  if (typeof serverName !== 'string' || serverName.length === 0) return null;
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  const capability = coveringCapability(app, descriptor);
  if (capability === null) return null;

  const grant = store.get(pluginId, app.appId, capability);
  if (!grant || grant.revokedAt !== null) return null;

  const declared = pluginAppCapabilityTools(app, capability);
  if (declared === null) return null;
  // A widened mapping asks for a tool the user never saw.
  if (pluginAppCapabilityMappingExpands(app, capability, grant.tools)) return null;
  // The approved scope is frozen: any change to the declared mapping, in
  // either direction, changes the digest and needs a fresh approval.
  if (grant.mappingRevision !== computePluginAppMappingRevision(capability, declared)) return null;
  const approved = grant.tools.some(
    (tool) => tool.toolName === toolName && serverMatches(tool.serverName, serverName),
  );
  return approved ? capability : null;
}

function hasCurrentGrant(
  store: PluginAppGrantStore,
  pluginId: string,
  app: PluginAppDefinition,
  capability: string,
): boolean {
  const grant = store.get(pluginId, app.appId, capability);
  if (!grant || grant.revokedAt !== null) return false;
  const declared = pluginAppCapabilityTools(app, capability);
  return declared !== null &&
    !pluginAppCapabilityMappingExpands(app, capability, grant.tools) &&
    grant.mappingRevision === computePluginAppMappingRevision(capability, declared);
}

/**
 * Grant-store backed Plugin App invocation authority.
 *
 * This is the authorization source: the durable grant ledger answers what the
 * user approved, and the trusted manifest answers what the plugin declares.
 * Nothing here infers a capability from a tool name, and nothing here grants
 * on its own — a missing, revoked, or drifted grant resolves to nothing.
 */
export function createHostPluginAppGrantAuthority(
  options: HostPluginAppGrantAuthorityOptions,
): HostPluginAppInvocationAuthority {
  const { store } = options;
  return {
    async resolveApp(pluginId: string, appId: string): Promise<PluginAppDefinition | null> {
      const app = await options.resolveApp(pluginId, appId);
      if (!app || app.appId !== appId) return null;
      return app;
    },
    async resolveGrantedCapabilities(input: {
      pluginId: string;
      appId: string;
      instanceId: string;
      sessionId: string;
      runId: string;
    }): Promise<readonly string[] | null> {
      try {
        const app = await options.resolveApp(input.pluginId, input.appId);
        if (!app || app.appId !== input.appId) return null;
        return store.listActiveCapabilities(input.pluginId, input.appId).filter(
          (capability) => app.requiredCapabilities.includes(capability) &&
            hasCurrentGrant(store, input.pluginId, app, capability),
        );
      } catch {
        // An unreadable ledger is an unavailable authority, not an empty one.
        return null;
      }
    },
    resolveToolCapability(input: {
      pluginId: string;
      app: PluginAppDefinition;
      descriptor: Readonly<Record<string, string>>;
    }): string | null {
      try {
        return resolveToolCapabilityFromGrants(
          store,
          input.pluginId,
          input.app,
          input.descriptor,
        );
      } catch {
        return null;
      }
    },
  };
}
