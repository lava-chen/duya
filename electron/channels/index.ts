/**
 * electron/channels — public API
 *
 * Re-exports all channel-related types and stores for use by other electron modules.
 * The agent subprocess accesses channel functionality exclusively through IPC handlers
 * exposed by this module's callers — it never imports these files directly.
 */

// Types (from agent package — safe to re-export for documentation and IPC typing)
export type {
  ChannelAddress,
  ChannelInboundEnvelope,
  ChannelOutboundMessage,
  ChannelReaction,
  ChannelConnectionConfig,
  ConnectorManifest,
  ConnectorSecretRecord,
  DeliveryFailure,
  KnownPlatform,
} from '../../packages/agent/src/channels/types';

export {
  CONNECTOR_MANIFESTS,
  formatChannelAddress,
  isKnownPlatform,
  KNOWN_PLATFORMS,
  parseChannelAddress,
} from '../../packages/agent/src/channels/types';

// Stores
export { FileChannelStore, openChannelStore, listAgentChannels, listAgentChannelAddresses } from './channel-store';
export { FileConnectorSecretStore, getConnectorSecretStore } from './connector-secret-store';
export type { ChannelStore } from './channel-store';
export type { ConnectorSecretStore } from './connector-secret-store';

// Agent session channel ops (plan 488 §3.4)
export {
  openAgentChannelStore,
  listAgentChannels,
  listChannelConfigs,
  storeConnectorCredential,
  getConnectorCredential,
  disconnectChannel,
  getAgentChannelAddress,
} from './agent-session-channels';

// Channel delivery (plan 488 §3.5 P2.2)
export {
  channelDelivery,
  registerTransport,
  getTransport,
  hasTransport,
  registeredPlatforms,
} from './channel-delivery';
export type { ChannelTransport } from './channel-delivery';
