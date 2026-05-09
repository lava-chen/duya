/**
 * Bridge module - MessagePort-based communication with Daemon
 *
 * Provides SessionBridge and SessionManager for direct Renderer-Daemon
 * communication via MessagePort, enabling low-latency chat streaming.
 */

export { SessionBridge } from './SessionBridge';
export { SessionManager } from './SessionManager';
export type { SessionBridgeOptions } from './SessionBridge';
export type {
  ChatOptions,
  SessionState,
  PortMessage,
  StreamPayload,
  ToolUsePayload,
  ToolResultPayload,
  PermissionRequestPayload,
} from './types';
