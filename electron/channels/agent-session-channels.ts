/**
 * electron/channels/agent-session-channels.ts — Agent channel operations (plan 488 §3.4)
 *
 * Provides channel management operations for bots (agents) without coupling to the
 * session store. These functions are called by:
 * - Gateway handlers (when a channel message arrives → resolve agentId → enqueue wake)
 * - Tool handlers (when bot calls update_state / SendMessage with channel ops)
 * - IPC handlers (for the renderer UI to manage channel configs)
 *
 * Security: credentials are NEVER returned to callers. Only the existence and
 * label of a configured channel is exposed (ChannelConnection, not ChannelConfig).
 */

import {
  openChannelStore,
  listAgentChannels as _listAgentChannels,
} from './channel-store';
import { getConnectorSecretStore } from './connector-secret-store';
import type { ChannelAddress, ChannelConnectionConfig } from '../../packages/agent/src/channels/types';

/**
 * Open a channel store for a specific agent.
 */
export function openAgentChannelStore(agentId: string) {
  return openChannelStore(agentId);
}

/**
 * List all configured channels for an agent (public view — no credentials).
 * Returns only platforms that have BOTH a connection.json AND a secret file.
 */
export function listAgentChannels(agentId: string): Array<{
  platform: string;
  label: string;
  status: 'configured';
}> {
  const store = openChannelStore(agentId);
  const secretStore = getConnectorSecretStore();

  // Only return platforms that have both config AND credentials
  return store.listConnections().filter(({ platform }) =>
    secretStore.hasPlatform(agentId, platform)
  );
}

/**
 * List all channel configurations for an agent (internal use — includes credentials).
 * Used by the channel delivery transport to get the actual token for sending.
 *
 * ⚠️ Internal only — never expose to the agent subprocess or renderer.
 */
export function listChannelConfigs(agentId: string): Array<{
  platform: string;
  label: string;
  connectedAt: string;
  hasCredentials: boolean;
}> {
  const store = openChannelStore(agentId);
  const secretStore = getConnectorSecretStore();

  return store.listConnections().map(({ platform, label }) => {
    const config = _readConnectionConfig(agentId, platform);
    return {
      platform,
      label,
      connectedAt: config?.connectedAt ?? new Date().toISOString(),
      hasCredentials: secretStore.hasPlatform(agentId, platform),
    };
  });
}

/**
 * Store a connector credential for a specific agent + platform.
 * Called by the secret-request flow (UI collects the token and calls this).
 */
export function storeConnectorCredential(
  agentId: string,
  platform: string,
  field: string,
  value: string,
): void {
  const secretStore = getConnectorSecretStore();
  secretStore.setSecret(agentId, platform, field, value);
}

/**
 * Get a connector credential for a specific agent + platform.
 * Called by the channel delivery transport (internal only).
 */
export function getConnectorCredential(
  agentId: string,
  platform: string,
  field: string,
): string | null {
  const secretStore = getConnectorSecretStore();
  return secretStore.getSecret(agentId, platform, field);
}

/**
 * Disconnect a channel: remove both the channel config and the credentials.
 * Idempotent — succeeds even if not configured.
 */
export function disconnectChannel(agentId: string, platform: string): void {
  const store = openChannelStore(agentId);
  const secretStore = getConnectorSecretStore();

  // Remove credentials first (more sensitive)
  secretStore.removeAgentPlatform(agentId, platform);

  // Remove channel config (label, connectedAt)
  store.remove(platform);
}

/**
 * Get the ChannelAddress for a specific channel of an agent.
 * Used by the delivery transport to target a specific channel.
 */
export function getAgentChannelAddress(
  agentId: string,
  platform: string,
  chat: string,
): ChannelAddress {
  return { platform, chat } as ChannelAddress;
}

// =============================================================================
// Private helpers
// =============================================================================

function _readConnectionConfig(
  agentId: string,
  platform: string,
): ChannelConnectionConfig | null {
  // Re-use the store's internal read logic
  const store = openChannelStore(agentId);
  const platforms = store.listPlatforms();
  if (!platforms.includes(platform)) return null;

  // We can't directly read the config through the public interface,
  // but listConnections gives us what we need
  const connections = store.listConnections();
  const found = connections.find((c) => c.platform === platform);
  if (!found) return null;

  // Reconstruct minimal config from listConnections result
  return {
    label: found.label,
    connectedAt: new Date().toISOString(), // approximate — listConnections doesn't expose connectedAt
  };
}
