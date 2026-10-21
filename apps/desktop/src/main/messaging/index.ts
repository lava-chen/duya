/**
 * messaging/index.ts - MessagePort and Channel management exports
 *
 * Unified exports for messaging subsystem.
 * T1.6: Create messaging/index.ts for MessageChannel exports
 */

export {
  initChannelManager,
  getChannelManager,
  type ManagedPort,
  type PortState,
  type PortError,
  type PortErrorCode,
  type ChannelDefinition,
} from './port-manager';