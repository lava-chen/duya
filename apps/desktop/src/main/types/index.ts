/**
 * Electron Types - Unified export barrel for all electron-side type definitions.
 *
 * Phase 9: Created to provide a single import point for shared types across
 * the electron process.
 */

// Model capabilities
export type {
  ModelCapabilities,
  ModelInfo,
} from './model-capabilities.js';

// MessagePort / channel types
export type {
  PortState,
  PortConfig,
  ElectronMessagePortMain,
  PortStats,
  ChannelMetrics,
  LatencyStats,
  PortMessage,
  PortMessageWithResponse,
  PortErrorCode,
  PortError,
  ReconnectEvent,
  ReconnectResult,
  ChannelDefinition,
} from './port-types.js';
export {
  DEFAULT_PORT_CONFIG,
  DEFAULT_CHANNEL_DEFINITIONS,
} from './port-types.js';

// Agent control channel message types
export type {
  PermissionRequestData,
  PermissionDecision,
  AgentToRendererMessage,
  RendererToAgentMessage,
  FileAttachment,
  ChatStartOptions,
} from './agent-message-types.js';
