import { createHash } from 'node:crypto';
import type {
  HostPluginAppGrantApiV1,
  PluginAppCapabilityGrant,
  PluginAppCapabilityTool,
} from '@duya/agent-protocol';
import {
  PluginAppGrantStoreError,
  type PluginAppGrantStore,
} from '@duya/data/plugin-app-grant-store';
import {
  pluginAppCapabilityToolKey,
  pluginAppCapabilityTools,
} from '@duya/plugin-core/apps/declarations';
import type { HostPluginAppInvocationAuthority } from './local-plugin-app-invocation-api.js';

export class HostPluginAppGrantApiError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 500 | 503) {
    super(code);
    this.name = 'HostPluginAppGrantApiError';
  }
}

/**
 * Digest of one capability's tool scope.
 *
 * A grant records the digest of what the user saw. When the plugin later
 * widens its mapping, the digest no longer matches and the grant stops
 * applying, so a wider scope needs a fresh approval.
 */
export function computePluginAppMappingRevision(
  capability: string,
  tools: readonly PluginAppCapabilityTool[],
): string {
  const payload = tools
    .map((tool) => pluginAppCapabilityToolKey(tool))
    .sort()
    .join('\u0001');
  return createHash('sha256').update(`${capability}\u0000${payload}`).digest('hex').slice(0, 32);
}

function sameToolScope(
  left: readonly PluginAppCapabilityTool[],
  right: readonly PluginAppCapabilityTool[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map((tool) => pluginAppCapabilityToolKey(tool)).sort();
  const rightKeys = right.map((tool) => pluginAppCapabilityToolKey(tool)).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

export interface HostPluginAppGrantOptions {
  readonly store: PluginAppGrantStore;
  /** Trusted manifest resolution; without it a grant cannot be written. */
  readonly authority?: HostPluginAppInvocationAuthority;
}

/**
 * Grant administration over the durable grant ledger.
 *
 * The approved scope is always the *declared* scope, never the scope the
 * caller sent: a caller can request a capability and present the exact tool
 * scope it showed, but it cannot approve a tool the plugin's manifest does
 * not map. The privileged local route requires the bearer token and rejects
 * browser Origins; it does not itself prove that a human approved the scope.
 */
export function createHostPluginAppGrantApi(
  options: HostPluginAppGrantOptions,
): HostPluginAppGrantApiV1 {
  return {
    async listPluginAppGrants(input): Promise<readonly PluginAppCapabilityGrant[]> {
      try {
        return options.store.listByApp(input.pluginId, input.appId);
      } catch (error) {
        if (error instanceof PluginAppGrantStoreError) {
          const status = error.reason === 'corrupt_tools' ? 500 : 400;
          throw new HostPluginAppGrantApiError(`plugin_app_grant_${error.reason}`, status);
        }
        throw error;
      }
    },
    async grantPluginAppCapability(input): Promise<PluginAppCapabilityGrant> {
      const { authority } = options;
      if (!authority) {
        throw new HostPluginAppGrantApiError('plugin_app_grant_authority_unavailable', 503);
      }
      const app = await authority.resolveApp(input.pluginId, input.appId);
      if (!app) {
        throw new HostPluginAppGrantApiError('plugin_app_manifest_unavailable', 404);
      }
      if (!app.requiredCapabilities.includes(input.capability)) {
        throw new HostPluginAppGrantApiError('plugin_app_capability_not_requested', 409);
      }
      const declared = pluginAppCapabilityTools(app, input.capability);
      if (declared === null) {
        throw new HostPluginAppGrantApiError('plugin_app_capability_unmapped', 409);
      }
      if (!sameToolScope(declared, input.tools)) {
        throw new HostPluginAppGrantApiError('plugin_app_grant_scope_mismatch', 409);
      }
      try {
        return options.store.grant({
          pluginId: input.pluginId,
          appId: input.appId,
          capability: input.capability,
          mappingRevision: computePluginAppMappingRevision(input.capability, declared),
          tools: declared,
        });
      } catch (error) {
        if (error instanceof PluginAppGrantStoreError) {
          throw new HostPluginAppGrantApiError(`plugin_app_grant_${error.reason}`, 400);
        }
        throw error;
      }
    },
    async revokePluginAppCapability(input): Promise<boolean> {
      try {
        return options.store.revoke({
          pluginId: input.pluginId,
          appId: input.appId,
          capability: input.capability,
        });
      } catch (error) {
        if (error instanceof PluginAppGrantStoreError) {
          throw new HostPluginAppGrantApiError(`plugin_app_grant_${error.reason}`, 400);
        }
        throw error;
      }
    },
  };
}
