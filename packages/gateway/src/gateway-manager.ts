/**
 * GatewayManager - Orchestrates platform adapters and message routing
 *
 * Lifecycle:
 * 1. Receive init config from Main Process
 * 2. Start enabled adapters with their credentials
 * 3. Route inbound messages → Main Process (via IPC)
 * 4. Route outbound messages → Platform adapters
 */

import type {
  PlatformType,
  PlatformConfig,
  GatewayInitConfig,
  GatewayStatus,
  AdapterStatus,
  NormalizedMessage,
  StreamEvent,
  NormalizedReply,
} from './types.js';
import { PlatformAdapter, createAdapter, getRegisteredPlatforms } from './adapters/base.js';
import { IpcClient } from './ipc-client.js';
import { UserMapper } from './user-mapper.js';
import { StreamHandler } from './stream-handler.js';
import { PermissionBroker } from './permission-broker.js';
import { setProxyUrl, initProxy } from './proxy-fetch.js';

export class GatewayManager {
  private running = false;
  private adapters = new Map<PlatformType, PlatformAdapter>();
  private adapterConfigs = new Map<PlatformType, PlatformConfig>();
  private ipc: IpcClient;
  private userMapper: UserMapper;
  private streamHandler: StreamHandler;
  private permissionBroker: PermissionBroker;
  private autoStart = false;

  constructor() {
    this.ipc = new IpcClient();
    this.userMapper = new UserMapper(this.ipc);
    this.streamHandler = new StreamHandler();
    this.permissionBroker = new PermissionBroker();

    // Wire up chatId resolver for stream handler
    this.streamHandler.setChatIdResolver(async (sessionId) => {
      const mapping = await this.userMapper.getChatIdForSession(sessionId);
      return mapping?.platformChatId ?? null;
    });
  }

  /**
   * Initialize with config from Main Process
   */
  async init(config: GatewayInitConfig): Promise<void> {
    this.autoStart = config.autoStart;

    if (config.proxyUrl) {
      setProxyUrl(config.proxyUrl);
    }
    initProxy();

    for (const platformConfig of config.platforms) {
      if (platformConfig.enabled) {
        this.adapterConfigs.set(platformConfig.platform, {
          platform: platformConfig.platform,
          credentials: platformConfig.credentials,
          options: platformConfig.options,
        });
      }
    }

    if (this.autoStart) {
      await this.start();
    }
  }

  /**
   * Start all configured adapters
   */
  async start(): Promise<void> {
    if (this.running) return;

    console.log('[GatewayManager] Starting adapters...');

    for (const [platform, config] of this.adapterConfigs) {
      try {
        const adapter = createAdapter(platform);
        if (!adapter) {
          console.warn(`[GatewayManager] No adapter registered for platform: ${platform}`);
          continue;
        }

        // Wire up inbound message handler
        adapter.onMessage((msg) => this.handleInboundMessage(msg));

        // Wire up command handler (for /new, /help, etc.)
        adapter.setCommandHandler(async (msg) => this.handleCommand(msg));

        await adapter.start(config);
        this.adapters.set(platform, adapter);
        console.log(`[GatewayManager] Adapter started: ${platform}`);
      } catch (err) {
        console.error(`[GatewayManager] Failed to start adapter ${platform}:`, err);
      }
    }

    this.running = true;
    console.log(`[GatewayManager] Running with ${this.adapters.size} adapter(s)`);
  }

  /**
   * Stop all adapters
   */
  async stop(): Promise<void> {
    console.log('[GatewayManager] Stopping adapters...');

    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.stop();
        console.log(`[GatewayManager] Adapter stopped: ${platform}`);
      } catch (err) {
        console.error(`[GatewayManager] Error stopping adapter ${platform}:`, err);
      }
    }

    this.adapters.clear();
    this.streamHandler.cleanupAll();
    this.running = false;
  }

  /**
   * Reload configuration and restart adapters with new config
   */
  async reloadConfig(config: GatewayInitConfig): Promise<void> {
    console.log('[GatewayManager] Reloading configuration...');

    // Stop existing adapters
    await this.stop();

    // Update adapter configs
    this.adapterConfigs.clear();
    for (const platformConfig of config.platforms) {
      if (platformConfig.enabled) {
        this.adapterConfigs.set(platformConfig.platform, {
          platform: platformConfig.platform,
          credentials: platformConfig.credentials,
          options: platformConfig.options,
        });
      }
    }

    // Restart adapters
    await this.start();

    console.log('[GatewayManager] Configuration reloaded');
  }

  /**
   * Get gateway status
   */
  getStatus(): GatewayStatus {
    const adapters: AdapterStatus[] = [];

    for (const [platform, adapter] of this.adapters) {
      const health = adapter.getHealth?.();
      adapters.push({
        platform,
        running: adapter.isRunning(),
        health,
      });
    }

    // Include configured but not started adapters
    for (const platform of this.adapterConfigs.keys()) {
      if (!this.adapters.has(platform)) {
        adapters.push({ platform, running: false });
      }
    }

    return {
      running: this.running,
      adapters,
      autoStart: this.autoStart,
    };
  }

  /**
   * Handle an outbound stream event from Main Process
   * Routes to the correct adapter based on session → platform mapping
   */
  async handleOutboundEvent(sessionId: string, event: StreamEvent): Promise<void> {
    // Look up which platform/chat this session belongs to
    const mapping = await this.userMapper.getChatIdForSession(sessionId);
    if (!mapping) {
      console.warn(`[GatewayManager] No platform mapping for session: ${sessionId}`);
      return;
    }

    const adapter = this.adapters.get(mapping.platform);
    if (!adapter) {
      console.warn(`[GatewayManager] No running adapter for platform: ${mapping.platform}`);
      return;
    }

    // Route to stream handler for platform-specific delivery
    await this.streamHandler.handleStreamEvent(sessionId, event, adapter);
  }

  /**
   * Handle a permission request from Main Process
   * Sends a message with inline buttons to the platform
   */
  async handlePermissionRequest(
    sessionId: string,
    permission: { id: string; toolName: string; toolInput: Record<string, unknown> },
  ): Promise<void> {
    const mapping = await this.userMapper.getChatIdForSession(sessionId);
    if (!mapping) return;

    const adapter = this.adapters.get(mapping.platform);
    if (!adapter) return;

    const reply = this.permissionBroker.createPermissionReply(permission);
    await adapter.sendReply(mapping.platformChatId, reply);
  }

  /**
   * Get the IpcClient instance (for subprocess message handler)
   */
  getIpcClient(): IpcClient {
    return this.ipc;
  }

  /**
   * Reset the session for an inbound platform message (/new command).
   * Creates a fresh session for the same (platform, platformChatId).
   */
  async resetSession(msg: NormalizedMessage): Promise<{ oldSessionId: string; newSessionId: string }> {
    return this.userMapper.resetSession(msg);
  }

  // ---------------------------------------------------------------------------
  // Private: Inbound message handling
  // ---------------------------------------------------------------------------

  private async handleInboundMessage(msg: NormalizedMessage): Promise<void> {
    try {
      // Check if this is a callback (permission button click)
      if (msg.callbackData) {
        const decision = this.permissionBroker.parseCallback(msg.callbackData);
        if (decision) {
          this.ipc.send({
            type: 'gateway:permission_resolve',
            permissionId: decision.permissionId,
            decision: decision.decision,
          });
          return;
        }
      }

      // Normal inbound message: resolve session and forward to Main
      const sessionId = await this.userMapper.getOrCreateSession(msg);

      this.ipc.send({
        type: 'gateway:inbound',
        sessionId,
        prompt: msg.text ?? '',
        platform: msg.platform,
        platformMsgId: msg.platformMsgId,
        platformChatId: msg.platformChatId,
      });
    } catch (err) {
      console.error('[GatewayManager] Error handling inbound message:', err);
      this.ipc.send({
        type: 'gateway:error',
        error: String(err),
      });
    }
  }

  /**
   * Handle a slash command (e.g., /new, /help, /status).
   * Returns true if the command was recognized and handled.
   */
  async handleCommand(msg: NormalizedMessage): Promise<boolean> {
    const text = msg.text ?? '';
    const parts = text.slice(1).split(/\s+/); // strip leading /
    const command = parts[0]?.toLowerCase() ?? '';
    const args = parts.slice(1);

    const adapter = this.adapters.get(msg.platform);
    if (!adapter) return false;

    try {
      if (command === 'new' || command === 'reset') {
        // /new or /reset: create a fresh session for the same platformChatId
        const { newSessionId } = await this.resetSession(msg);
        await adapter.sendReply(msg.platformChatId, {
          type: 'text',
          text: `✨ Session reset! Starting fresh.\n\nNew session: \`${newSessionId}\``,
          parseMode: 'Markdown',
        });
        return true;
      }

      if (command === 'help') {
        // /help: show available commands
        await adapter.sendReply(msg.platformChatId, {
          type: 'text',
          text: [
            '*Available Commands:*',
            '',
            '`/new` - Start a fresh session (same as /reset)',
            '`/help` - Show this help message',
            '`/status` - Show current session info',
            '',
            'All other messages are sent to the AI agent.',
          ].join('\n'),
          parseMode: 'Markdown',
        });
        return true;
      }

      if (command === 'status') {
        // /status: show session info
        const mapping2 = await this.ipc.request('db:request', {
          action: 'gateway_user:getMapping',
          payload: { platform: msg.platform, platformChatId: msg.platformChatId },
        }) as { session_id?: string } | null;
        const sessionId = mapping2?.session_id ?? '(no active session)';
        await adapter.sendReply(msg.platformChatId, {
          type: 'text',
          text: [
            '*Session Status*',
            '',
            `Platform: ${msg.platform}`,
            `Chat ID: \`${msg.platformChatId}\``,
            `Session: \`${sessionId}\``,
            `Running: ${this.running ? 'Yes' : 'No'}`,
          ].join('\n'),
          parseMode: 'Markdown',
        });
        return true;
      }

      return false; // Unknown command
    } catch (err) {
      console.error('[GatewayManager] Error handling command:', err);
      await adapter.sendReply(msg.platformChatId, {
        type: 'error',
        message: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return true; // Still return true to prevent the unknown-command path
    }
  }
}
