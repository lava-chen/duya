/**
 * PlatformAdapter - Abstract interface for all platform integrations
 *
 * Each platform (Telegram, Feishu, WeChat, Discord) implements this interface.
 * The GatewayManager calls these methods to manage the adapter lifecycle
 * and route messages between the platform and the Main Process.
 */

import type {
  PlatformType,
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../types.js';

export interface PlatformAdapter {
  readonly platform: PlatformType;

  /**
   * Start the adapter - establish webhook server or long polling connection
   * Called by GatewayManager when the platform is enabled and configured
   */
  start(config: PlatformConfig): Promise<void>;

  /** Stop the adapter - disconnect from platform, clean up resources */
  stop(): Promise<void>;

  /** Check if the adapter is currently running */
  isRunning(): boolean;

  /**
   * Get the adapter's health status
   * Returns detailed connection health information
   */
  getHealth?(): { connected: boolean; lastConnectedAt?: number; lastErrorAt?: number; lastError?: string; consecutiveErrors: number; totalMessages: number; botUsername?: string };

  /**
   * Register a handler for inbound messages from the platform
   * The adapter calls this handler whenever it receives a non-command message
   */
  onMessage(handler: (msg: NormalizedMessage) => void): void;

  /**
   * Register a handler for slash commands (e.g., /new, /help, /status)
   * The adapter calls this for messages that start with /
   * Returns true if the command was handled, false otherwise
   */
  setCommandHandler(handler: (msg: NormalizedMessage) => Promise<boolean>): void;

  /**
   * Send a reply to the platform
   * The GatewayManager calls this for outbound messages (Agent responses)
   */
  sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult>;

  /**
   * Send typing indicator (optional)
   * Some platforms support showing "bot is typing..." status
   */
  sendTyping?(chatId: string): Promise<void>;
}

/**
 * Adapter factory registry
 * Adapters self-register via registerAdapterFactory() on import
 */
export type AdapterFactory = (platform: PlatformType) => PlatformAdapter;

const adapterRegistry = new Map<PlatformType, AdapterFactory>();

export function registerAdapterFactory(
  platform: PlatformType,
  factory: AdapterFactory
): void {
  adapterRegistry.set(platform, factory);
}

export function createAdapter(platform: PlatformType): PlatformAdapter | null {
  const factory = adapterRegistry.get(platform);
  return factory ? factory(platform) : null;
}

export function getRegisteredPlatforms(): PlatformType[] {
  return Array.from(adapterRegistry.keys());
}
