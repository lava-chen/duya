/**
 * GatewayManager - Orchestrates platform adapters and message routing
 *
 * Lifecycle:
 * 1. Receive init config from Main Process
 * 2. Start enabled adapters in parallel with independent timeouts
 * 3. Route inbound messages → Main Process (via IPC)
 * 4. Route outbound messages → Platform adapters
 */

import type {
  PlatformType,
  PlatformConfig,
  GatewayInitConfig,
  GatewayProxyConfig,
  GatewayStatus,
  AdapterStatus,
  NormalizedMessage,
  StreamEvent,
  NormalizedReply,
  MediaReply,
} from './types.js';
import { extname } from 'node:path';
import { PlatformAdapter, createAdapter, getRegisteredPlatforms } from './adapters/base.js';
import { IpcClient } from './ipc-client.js';
import { UserMapper } from './user-mapper.js';
import { StreamHandler } from './stream-handler.js';
import { DeliveryLedger } from './delivery-ledger.js';
import { DeliveryMirror } from './delivery-mirror.js';
import { matchProfileRoute, parseProfileRoutes, type ProfileRoute } from './profile-routing.js';
import { PermissionBroker } from './permission-broker.js';
import { setProxyUrl, initProxy } from './proxy-fetch.js';
import { buildAttachments } from './attachment-builder.js';
import { resolveDisplayConfig, type DisplayUserConfig } from './display-config.js';

const ADAPTER_START_TIMEOUT_MS = 30_000;
const ADAPTER_STOP_TIMEOUT_MS = 10_000;

export class GatewayManager {
  private running = false;
  private adapters = new Map<PlatformType, PlatformAdapter>();
  private adapterConfigs = new Map<PlatformType, PlatformConfig>();
  private ipc: IpcClient;
  private userMapper: UserMapper;
  private streamHandler: StreamHandler;
  private permissionBroker: PermissionBroker;
  private ledger: DeliveryLedger;
  private mirror: DeliveryMirror;
  private profileRoutes: ProfileRoute[] = [];
  private autoStart = false;
  private proxyConfig?: GatewayProxyConfig;
  /** Last activity timestamp per (platform:chatId) for idle-based session reset. */
  private lastActivityByChat = new Map<string, number>();
  /** Queued inbound text per busy session (merged into a single prompt). */
  private busyQueue = new Map<string, string[]>();
  /**
   * Periodic sweep of ledger obligations for connected adapters. Backstop for
   * the reconnect hook: a failed send lands in the ledger AFTER the channel
   * reconnects, so the reconnect event itself cannot see it. The sweep retries
   * it on the next tick instead of waiting for a process restart.
   */
  private redeliveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.ipc = new IpcClient();
    this.userMapper = new UserMapper(this.ipc);
    this.ledger = new DeliveryLedger();
    this.ledger.load();
    this.mirror = new DeliveryMirror(this.ipc);
    this.streamHandler = new StreamHandler(undefined, this.ledger, this.mirror);
    this.permissionBroker = new PermissionBroker();

    // Wire up chatId resolver for stream handler
    this.streamHandler.setChatIdResolver(async (sessionId) => {
      const mapping = await this.userMapper.getChatIdForSession(sessionId);
      return mapping?.platformChatId ?? null;
    });

    // Wire up per-platform display config for the stream handler.
    this.streamHandler.setDisplayConfigResolver((platform) => {
      const cfg = resolveDisplayConfig(platform);
      return {
        showReasoning: cfg.showReasoning,
        toolProgress: cfg.toolProgress,
        toolPreviewLength: cfg.toolPreviewLength,
        streaming: cfg.streaming,
      };
    });

    // Wire up per-platform reaction emoji resolver for the stream handler.
    this.streamHandler.setReactionConfigResolver((platform) => {
      const opts = this.adapterConfigs.get(platform)?.options ?? {};
      const r = (opts as { reactions?: { enabled?: boolean; working?: string; done?: string; error?: string } }).reactions;
      // Defaults must be in Telegram's built-in reaction emoji set; custom
      // emoji like 🔨/✅/❌ are rejected with REACTION_INVALID for free bots.
      return {
        enabled: r?.enabled ?? true,
        working: r?.working ?? '🤔',
        done: r?.done ?? '👍',
        error: r?.error ?? '👎',
      };
    });
  }

  /**
   * Initialize with config from Main Process
   */
  async init(config: GatewayInitConfig): Promise<void> {
    this.autoStart = config.autoStart;
    this.proxyConfig = config.proxyConfig;
    console.log('[STARTUP] GatewayManager.init received config:');
    console.log('[STARTUP]   autoStart:', config.autoStart);
    console.log('[STARTUP]   platforms count:', config.platforms.length);
    console.log('[STARTUP]   proxyConfig:', config.proxyConfig ? { globalEnabled: config.proxyConfig.globalEnabled, channels: Object.keys(config.proxyConfig.channels) } : 'undefined');
    for (const p of config.platforms) {
      console.log('[STARTUP]   platform:', p.platform, 'enabled:', p.enabled, 'hasCredentials:', !!(p.credentials && Object.keys(p.credentials).length > 0), 'credentialsKeys:', Object.keys(p.credentials || {}));
    }

    if (config.proxyUrl) {
      setProxyUrl(config.proxyUrl);
    }
    initProxy();

    this.adapterConfigs.clear();
    this.profileRoutes = parseProfileRoutes(config.profileRoutes);
    for (const platformConfig of config.platforms) {
      if (platformConfig.enabled) {
        // Determine if this platform should use proxy based on per-channel config
        const useProxy = this.shouldUseProxyForPlatform(platformConfig.platform);
        console.log('[STARTUP] GatewayManager storing config for:', platformConfig.platform, 'useProxy:', useProxy);
        this.adapterConfigs.set(platformConfig.platform, {
          platform: platformConfig.platform,
          credentials: platformConfig.credentials,
          options: platformConfig.options,
          useProxy,
        });
      }
    }

    console.log(`[GatewayManager] Init complete, autoStart=${this.autoStart}, platforms=${this.adapterConfigs.size}`);
    console.log('[STARTUP] adapterConfigs after init:', Array.from(this.adapterConfigs.entries()).map(([k, v]) => ({ platform: k, credentialsKeys: Object.keys(v.credentials), useProxy: v.useProxy })));
  }

  /**
   * Determine if a platform should use proxy based on per-channel configuration
   */
  private shouldUseProxyForPlatform(platform: PlatformType): boolean {
    if (!this.proxyConfig) {
      return true; // Default to using proxy if no config
    }
    // Check per-channel setting first, fallback to global
    const channelSetting = this.proxyConfig.channels[platform];
    if (channelSetting !== undefined) {
      return channelSetting;
    }
    return this.proxyConfig.globalEnabled;
  }

  /**
   * Start all configured adapters in parallel.
   * Each adapter starts independently with its own timeout.
   * One adapter failing or hanging does NOT block others.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log('[GatewayManager] Starting adapters in parallel, configs:', Array.from(this.adapterConfigs.keys()));
    console.log('[STARTUP] adapterConfigs details:', Array.from(this.adapterConfigs.entries()).map(([platform, config]) => ({ platform, hasCredentials: !!config.credentials, credentialsKeys: config.credentials ? Object.keys(config.credentials) : [] })));

    const startTasks = Array.from(this.adapterConfigs).map(
      async ([platform, config]): Promise<{ platform: PlatformType; adapter: PlatformAdapter | null; error?: unknown }> => {
        const platformType = platform as PlatformType;
        try {
          const adapter = createAdapter(platform);
          if (!adapter) {
            console.warn(`[GatewayManager] No adapter registered for platform: ${platform}`);
            return { platform: platformType, adapter: null };
          }

          adapter.onMessage((msg) => this.handleInboundMessage(msg));
          adapter.setCommandHandler(async (msg) => this.handleCommand(msg));

          if ('getIpcClient' in adapter) {
            (adapter as { getIpcClient?: () => IpcClient }).getIpcClient = () => this.ipc;
          }

          await Promise.race([
            adapter.start(config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Adapter start timeout after ${ADAPTER_START_TIMEOUT_MS}ms`)), ADAPTER_START_TIMEOUT_MS)
            ),
          ]);

          // Flush delivery-ledger redeliveries whenever this channel recovers
          // from a disconnect. A final reply that failed to send while the
          // channel was down must not wait for a process restart to be retried.
          adapter.onReconnected?.(() => {
            console.log(`[GatewayManager] Adapter reconnected: ${platform}, flushing pending redeliveries`);
            this.streamHandler.redeliverRecoverable(
              (p) => this.adapters.get(p as PlatformType),
              [platformType],
            ).then((n) => {
              if (n > 0) console.log(`[GatewayManager] Reconnected redelivery: delivered ${n} message(s) for ${platform}`);
            }).catch((err) => {
              console.error(`[GatewayManager] Reconnected redelivery failed for ${platform}:`, err);
            });
          });

          console.log(`[GatewayManager] Adapter started: ${platform}`);
          return { platform: platformType, adapter };
        } catch (err) {
          console.error(`[GatewayManager] Failed to start adapter ${platform}:`, err);
          return { platform: platformType, adapter: null, error: err };
        }
      }
    );

    const results = await Promise.allSettled(startTasks);

    let startedCount = 0;
    let failedCount = 0;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { platform, adapter } = result.value;
        if (adapter) {
          this.adapters.set(platform, adapter);
          startedCount++;
        }
      } else {
        console.error('[GatewayManager] Unexpected adapter start rejection:', result.reason);
        failedCount++;
      }
    }

    console.log(`[GatewayManager] Started ${startedCount}/${this.adapterConfigs.size} adapter(s)` + (failedCount > 0 ? `, ${failedCount} failed` : ''));

    // After adapters are up, redeliver any obligations recovered from a
    // previous crash. Best-effort: failures stay in the ledger for a later
    // retry boundary.
    const redelivered = await this.streamHandler.redeliverRecoverable(
      (platform) => this.adapters.get(platform as PlatformType),
    );
    if (redelivered > 0) {
      console.log(`[GatewayManager] Redelivered ${redelivered} recoverable message(s) from delivery ledger`);
    }

    // Periodic backstop sweep (60s). Only connected adapters are swept so a
    // still-offline channel's obligations are not burned against a dead link.
    if (!this.redeliveryTimer) {
      this.redeliveryTimer = setInterval(() => {
        const connectedPlatforms = Array.from(this.adapters.entries())
          .filter(([, a]) => a.getHealth?.().connected ?? a.isRunning())
          .map(([p]) => p);
        if (connectedPlatforms.length === 0) return;
        this.streamHandler.redeliverRecoverable(
          (platform) => this.adapters.get(platform as PlatformType),
          connectedPlatforms,
        ).then((n) => {
          if (n > 0) console.log(`[GatewayManager] Periodic sweep delivered ${n} pending message(s)`);
        }).catch((err) => {
          console.error('[GatewayManager] Periodic redelivery sweep failed:', err);
        });
      }, 60_000);
    }

    // Broadcast gateway-online to the home channel (Hermes parity).
    await this.broadcastHome('🟢 Gateway online');
  }

  /**
   * Best-effort broadcast of a status text to the configured home channel.
   * Reads `telegram_home_channel` from settings; failures are silent.
   */
  private async broadcastHome(text: string): Promise<void> {
    try {
      const result = await this.ipc.request('db:request', {
        action: 'settings:get',
        payload: { key: 'telegram_home_channel' },
      });
      const homeChat = typeof result === 'string' && result ? result : (result as { result?: string })?.result;
      if (!homeChat) return;
      const adapter = this.adapters.get('telegram');
      if (!adapter) return;
      await adapter.sendReply(homeChat, { type: 'text', text });
    } catch {
      // Silent: home channel may not be configured or reachable.
    }
  }

  /**
   * Stop all adapters in parallel.
   * Each adapter stops independently with its own timeout.
   */
  async stop(): Promise<void> {
    console.log('[GatewayManager] Stopping adapters in parallel...');

    // Broadcast gateway-offline to the home channel before adapters go down
    // (Hermes parity). Best-effort and silent on failure.
    await this.broadcastHome('🔴 Gateway offline');

    // Graceful shutdown flush: attempt one final delivery of any recoverable
    // obligations while adapters are still online. Anything still failing is
    // durable in the ledger and will be re-attempted on the next boot.
    try {
      const flushed = await this.streamHandler.redeliverRecoverable(
        (platform) => this.adapters.get(platform as PlatformType),
      );
      if (flushed > 0) {
        console.log(`[GatewayManager] Shutdown flush delivered ${flushed} pending message(s)`);
      }
    } catch (err) {
      console.error('[GatewayManager] Shutdown flush failed:', err);
    }

    const stopTasks = Array.from(this.adapters).map(
      async ([platform, adapter]) => {
        try {
          await Promise.race([
            adapter.stop(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Adapter stop timeout after ${ADAPTER_STOP_TIMEOUT_MS}ms`)), ADAPTER_STOP_TIMEOUT_MS)
            ),
          ]);
          console.log(`[GatewayManager] Adapter stopped: ${platform}`);
        } catch (err) {
          console.error(`[GatewayManager] Error stopping adapter ${platform}:`, err);
        }
      }
    );

    await Promise.allSettled(stopTasks);

    if (this.redeliveryTimer) {
      clearInterval(this.redeliveryTimer);
      this.redeliveryTimer = null;
    }

    this.adapters.clear();
    this.streamHandler.cleanupAll();
    this.running = false;

    console.log('[GatewayManager] All adapters stopped');
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
      const displayConfig = resolveDisplayConfig(platform);
      adapters.push({
        platform,
        running: adapter.isRunning(),
        health,
        displayConfig: {
          streaming: displayConfig.streaming,
          toolProgress: displayConfig.toolProgress,
          showReasoning: displayConfig.showReasoning,
        },
      });
    }

    // Include configured but not started adapters
    for (const platform of this.adapterConfigs.keys()) {
      if (!this.adapters.has(platform)) {
        const displayConfig = resolveDisplayConfig(platform);
        adapters.push({
          platform,
          running: false,
          displayConfig: {
            streaming: displayConfig.streaming,
            toolProgress: displayConfig.toolProgress,
            showReasoning: displayConfig.showReasoning,
          },
        });
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
   * @param sessionId - The session ID
   * @param event - The stream event
   * @param directPlatform - Optional platform passed directly from Main to avoid DB race condition
   * @param directPlatformChatId - Optional platformChatId passed directly from Main to avoid DB race condition
   */
  async handleOutboundEvent(
    sessionId: string,
    event: StreamEvent,
    directPlatform?: string,
    directPlatformChatId?: string
  ): Promise<void> {
    // Use direct platformChatId if provided (avoids DB race condition)
    if (directPlatform && directPlatformChatId) {
      const adapter = this.adapters.get(directPlatform as PlatformType);
      if (!adapter) {
        console.warn(`[GatewayManager] No running adapter for platform: ${directPlatform}`);
        return;
      }
      await this.streamHandler.handleStreamEvent(sessionId, event, adapter, directPlatformChatId);
      return;
    }

    // Fallback: look up which platform/chat this session belongs to
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
   * Proactively send a plain text message to a channel, independent of any
   * inbound message or active stream. This is the CLI-driven path (openclaw /
   * hermes-style) for pushing a message to an IM channel without a trigger.
   * Returns `{ ok, error?, platformMsgId? }` so the caller can surface the
   * outcome synchronously.
   */
  async sendMessage(
    platform: string,
    platformChatId: string,
    text: string,
    filePath?: string,
  ): Promise<{ ok: boolean; error?: string; platformMsgId?: string }> {
    const adapter = this.adapters.get(platform as PlatformType);
    if (!adapter) {
      return { ok: false, error: `No running adapter for platform: ${platform}` };
    }
    if (!text.trim() && !filePath) {
      return { ok: false, error: 'Message text or filePath must not be empty' };
    }
    try {
      let reply: NormalizedReply;
      if (filePath) {
        // Reuse the same media delivery the outbound stream handler uses:
        // build an in-memory MediaReply, and `adapter.sendReply` routes the
        // `'media'` case to that adapter's existing `sendMedia` implementation.
        const mediaReply: MediaReply = {
          type: 'media',
          mediaType: inferMediaType(filePath),
          filePath,
          ...(text.trim() ? { caption: text } : {}),
        };
        reply = mediaReply;
      } else {
        reply = { type: 'text', text };
      }
      const result = await adapter.sendReply(platformChatId, reply);
      return {
        ok: result?.ok !== false,
        ...(result?.platformMsgId ? { platformMsgId: result.platformMsgId } : {}),
        ...(result?.ok === false && result?.error ? { error: result.error } : {}),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Get the IpcClient instance (for subprocess message handler)
   */
  getIpcClient(): IpcClient {
    return this.ipc;
  }

  /**
   * Register dynamically-provided commands (e.g. installed skills surfaced as
   * slash commands). Wired here so callers can add commands at runtime and
   * `resolveCommand` / `generateHelpText` pick them up immediately.
   */
  registerDynamicCommands(list: Array<{ name: string; aliases?: readonly string[]; description: string; category: string }>): void {
    void import('./commands/registry.js').then((mod) => {
      mod.registerDynamicCommands(list as Parameters<typeof mod.registerDynamicCommands>[0]);
    });
  }

  /**
   * Handle session reset notification from Main Process.
   * Cleans up local state (active streams) for the given session.
   */
  onSessionReset(sessionId: string): void {
    this.streamHandler.cleanupStream(sessionId);
  }

  /**
   * Handle display state changes from the agent (typing, tool progress, etc.)
   * Forwards to the relevant adapter for platform-specific display handling.
   */
  handleDisplayState(platform: string, platformChatId: string, state: string): void {
    const adapter = this.adapters.get(platform as PlatformType);
    if (!adapter) return;

    if (state === 'typing_start') {
      adapter.sendTyping?.(platformChatId);
    } else if (state === 'typing_stop') {
      adapter.stopTyping?.(platformChatId);
    }
  }

  /**
   * Reset the session for an inbound platform message (/new command).
   * Creates a fresh session for the same (platform, platformChatId).
   */
  async resetSession(msg: NormalizedMessage): Promise<{ oldSessionId: string; newSessionId: string }> {
    return this.userMapper.resetSession(msg);
  }

  /**
   * Whether the given session currently has an active stream (agent busy).
   */
  private isSessionBusy(sessionId: string): boolean {
    return this.streamHandler.hasActiveStream(sessionId);
  }

  /**
   * Read the busy-input mode for a platform ('queue' | 'steer' | 'interrupt').
   * Defaults to 'queue' (Hermes default: acknowledge and enqueue).
   */
  private getBusyMode(platform: PlatformType): 'queue' | 'steer' | 'interrupt' {
    const opts = this.adapterConfigs.get(platform)?.options;
    const mode = (opts as { busy_input?: 'queue' | 'steer' | 'interrupt' } | undefined)?.busy_input;
    return mode ?? 'queue';
  }

  /**
   * Check whether the (platform:chatId) requires a session reset based on the
   * configured reset policy (daily / idle / both / off). Returns true when a
   * reset should happen before processing the next message.
   */
  private shouldResetSession(platform: PlatformType, chatId: string): boolean {
    const opts = this.adapterConfigs.get(platform)?.options;
    const o = opts as {
      reset_policy?: 'daily' | 'idle' | 'both' | 'off';
      reset_hour?: number;
      reset_idle_minutes?: number;
    } | undefined;

    const policy = o?.reset_policy ?? 'off';
    if (policy === 'off') return false;

    const now = Date.now();
    const key = `${platform}:${chatId}`;

    // Idle-based reset: no activity for reset_idle_minutes (default 30).
    if (policy === 'idle' || policy === 'both') {
      const idleMinutes = o?.reset_idle_minutes ?? 30;
      const last = this.lastActivityByChat.get(key);
      if (last !== undefined) {
        const elapsedMin = (now - last) / 60_000;
        if (elapsedMin >= idleMinutes) {
          this.lastActivityByChat.delete(key);
          return true;
        }
      }
      if (policy === 'idle') return false;
    }

    // Daily reset: wall-clock hour crossed reset_hour (default 0).
    if (policy === 'daily' || policy === 'both') {
      const hour = new Date(now).getHours();
      const resetHour = o?.reset_hour ?? 0;
      const last = this.lastActivityByChat.get(key);
      if (last !== undefined) {
        const lastHour = new Date(last).getHours();
        if (hour === resetHour && lastHour !== resetHour) {
          this.lastActivityByChat.set(key, now);
          return true;
        }
      }
    }

    return false;
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

      // Track activity for idle/daily session auto-reset.
      const actKey = `${msg.platform}:${msg.platformChatId}`;
      this.lastActivityByChat.set(actKey, Date.now());

      // Session auto-reset policy: if the configured window has elapsed, start
      // a fresh session before processing this message (Hermes daily/idle reset).
      if (this.shouldResetSession(msg.platform, msg.platformChatId)) {
        await this.resetSession(msg);
        return;
      }

      // Busy-input handling: when the agent is already streaming for this
      // session, honor the configured mode (queue / steer / interrupt) and
      // return a busy-ack instead of blindly enqueueing a duplicate turn.
      if (this.isSessionBusy(sessionId)) {
        const busyMode = this.getBusyMode(msg.platform);
        const busyText = msg.text ?? '';

        if (busyMode === 'interrupt') {
          this.ipc.interruptSession(sessionId);
          this.streamHandler.cleanupStream(sessionId);
          await this.forwardInbound(msg, sessionId, {});
          await this.adapters.get(msg.platform)?.sendReply?.(msg.platformChatId, {
            type: 'text',
            text: '⏸️ 已中断当前运行，正在处理你的消息…',
          });
          return;
        }

        if (busyMode === 'steer') {
          // Inject the message into the current run (no new turn).
          await this.forwardInbound(msg, sessionId, { steer: true });
          await this.adapters.get(msg.platform)?.sendReply?.(msg.platformChatId, {
            type: 'text',
            text: '⏩ 已注入当前运行。',
          });
          return;
        }

        // queue (default): merge text into the busy session buffer and
        // acknowledge. The merged prompt is flushed once the stream is idle.
        const queue = this.busyQueue.get(sessionId) ?? [];
        queue.push(busyText);
        this.busyQueue.set(sessionId, queue);
        await this.adapters.get(msg.platform)?.sendReply?.(msg.platformChatId, {
          type: 'text',
          text: '⏳ 正在处理上一条消息，已排队。',
        });
        return;
      }

      // Flush any queued messages from a previous busy window into one prompt.
      const queued = this.busyQueue.get(sessionId);
      if (queued && queued.length > 0) {
        this.busyQueue.delete(sessionId);
        const merged = [...queued, msg.text ?? ''].filter(Boolean).join('\n');
        await this.forwardInbound(msg, sessionId, { mergedPrompt: true });
        return;
      }

      // Remember the user's message ID so outbound replies quote it (hermes-style).
      this.streamHandler.setReplyTarget(sessionId, msg.platformMsgId);

      // Signal "working" on the user's message via a reaction (hermes-style).
      const adapter = this.adapters.get(msg.platform);
      const reactionOpts = (this.adapterConfigs.get(msg.platform)?.options ?? {}) as
        { reactions?: { enabled?: boolean; working?: string } };
      const reactionsEnabled = reactionOpts.reactions?.enabled ?? true;
      const workingEmoji = reactionOpts.reactions?.working ?? '🤔';
      if (reactionsEnabled) {
        adapter?.setMessageReaction?.(msg.platformChatId, msg.platformMsgId, workingEmoji);
      }

      // Build attachments from all attachment fields (images/files/voice/video)
      const options: Record<string, unknown> = {};
      const attachments = await buildAttachments({
        images: msg.images,
        imagePaths: msg.imagePaths,
        files: msg.files,
        filePaths: msg.filePaths,
        voicePaths: msg.voicePaths,
        videoPaths: msg.videoPaths,
      });
      if (attachments.length > 0) {
        options.files = attachments;
      }

      // Profile routing (basic version): if a route matches this (platform,
      // chatId), carry the resolved profile so the worker can use it. When no
      // route matches, options.profile stays undefined and the default
      // gateway profile is used.
      const route = matchProfileRoute(this.profileRoutes, {
        platform: msg.platform,
        chatId: msg.platformChatId,
        threadId: msg.threadId,
      });
      if (route) {
        options.profile = route.profile;
      }

      await this.forwardInbound(msg, sessionId, options);

      const typingAdapter = this.adapters.get(msg.platform);
      typingAdapter?.sendTyping?.(msg.platformChatId);
    } catch (err) {
      console.error('[GatewayManager] Error handling inbound message:', err);
      this.ipc.send({
        type: 'gateway:error',
        error: String(err),
      });
    }
  }

  /**
   * Forward a normalized inbound message to Main as a gateway:inbound event,
   * carrying optional extra options (background / steer / mergedPrompt / ...).
   */
  private async forwardInbound(
    msg: NormalizedMessage,
    sessionId: string,
    extraOptions: Record<string, unknown>,
  ): Promise<void> {
    const options: Record<string, unknown> = { ...extraOptions };

    // Build attachments from all attachment fields (images/files/voice/video).
    const attachments = await buildAttachments({
      images: msg.images,
      imagePaths: msg.imagePaths,
      files: msg.files,
      filePaths: msg.filePaths,
      voicePaths: msg.voicePaths,
      videoPaths: msg.videoPaths,
    });
    if (attachments.length > 0) {
      options.files = attachments;
    }

    // Profile routing: carry the resolved profile so the worker can use it.
    const route = matchProfileRoute(this.profileRoutes, {
      platform: msg.platform,
      chatId: msg.platformChatId,
      threadId: msg.threadId,
    });
    if (route) {
      options.profile = route.profile;
    }

    this.ipc.send({
      type: 'gateway:inbound',
      sessionId,
      prompt: msg.text ?? '',
      platform: msg.platform,
      platformMsgId: msg.platformMsgId,
      platformChatId: msg.platformChatId,
      options,
    });
  }

  /**
   * Get current model info from settings
   */
  private async getModelInfo(): Promise<{ model?: string; provider?: string }> {
    try {
      const result = await this.ipc.request('db:request', {
        action: 'settings:get',
        payload: { key: 'gatewayModel' },
      });
      const model = typeof result === 'string' ? result : (result as { result?: string })?.result;
      return { model: model as string | undefined };
    } catch {
      return {};
    }
  }

  /**
   * Resolve the current session id for a platform+chat (best-effort).
   */
  private async getSessionId(msg: NormalizedMessage): Promise<string | null> {
    try {
      const existing = await this.ipc.request('db:request', {
        action: 'gateway_user:getMapping',
        payload: {
          platform: msg.platform,
          platformChatId: msg.platformChatId,
        },
      });
      return typeof existing === 'string' && existing ? existing : null;
    } catch {
      return null;
    }
  }

  /**
   * Attempt to persist a settings key via the gateway IPC surface. The main
   * process db-bridge currently only exposes `settings:get`; if `settings:set`
   * is unavailable the call fails gracefully and returns false.
   */
  private async updateSetting(key: string, value: unknown): Promise<boolean> {
    try {
      const result = await this.ipc.request('db:request', {
        action: 'settings:set',
        payload: { key, value },
      });
      return result !== undefined && result !== null;
    } catch {
      return false;
    }
  }

  /**
   * Handle a slash command (e.g., /new, /help, /status).
   * Returns true if the command was recognized and handled.
   */
  async handleCommand(msg: NormalizedMessage): Promise<boolean> {
    const text = msg.text ?? '';
    if (!text.startsWith('/')) return false;

    const parts = text.slice(1).split(/\s+/);
    const commandName = parts[0]?.toLowerCase() ?? '';
    const args = parts.slice(1);

    const adapter = this.adapters.get(msg.platform);
    if (!adapter) return false;

    try {
      // Use shared command registry
      const { resolveCommand, getAllCommands } = await import('./commands/registry.js');
      const { generateHelpText } = await import('./commands/help.js');
      const cmd = resolveCommand(text);

      if (!cmd) {
        // Unknown command - pass through to agent
        return false;
      }

      // Handle commands based on registry definition
      switch (cmd.name) {
        case 'new':
        case 'reset': {
          const { newSessionId } = await this.resetSession(msg);
          const { model } = await this.getModelInfo();
          const lines = [
            '✨ Session reset! Starting fresh.',
            `Session: \`${newSessionId}\``,
          ];
          if (model) {
            lines.push(`Model: \`${model}\``);
          }
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: lines.join('\n\n'),
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'help': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: generateHelpText('gateway'),
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'status': {
          const mapping2 = await this.ipc.request('db:request', {
            action: 'gateway_user:getMapping',
            payload: { platform: msg.platform, platformChatId: msg.platformChatId },
          }) as { session_id?: string } | null;
          const sessionId = mapping2?.session_id ?? '(no active session)';
          const { model } = await this.getModelInfo();

          const lines = [
            '*Session Status*',
            '',
            `Platform: ${msg.platform}`,
            `Chat ID: \`${msg.platformChatId}\``,
            `Session: \`${sessionId}\``,
            `Model: \`${model ?? 'default'}\``,
            `Running: ${this.running ? 'Yes' : 'No'}`,
          ];

          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: lines.join('\n'),
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'pair': {
          // Generate pairing code for this user
          const userName = `User_${msg.platformUserId}`;
          const result = await this.ipc.generatePairingCode(
            msg.platform,
            msg.platformUserId,
            msg.platformChatId,
            userName
          ) as { code?: string; error?: string };

          if (result.error) {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: `❌ Pairing error: ${result.error}`,
            });
          } else {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: `🔑 *Pairing Code*\n\nYour code: \`${result.code}\`\n\nShare this code with the admin to get approved. Code expires in 1 hour.\n\nUse /status to check your approval status.`,
              parseMode: 'Markdown',
            });
          }
          return true;
        }

        case 'model': {
          const { model } = await this.getModelInfo();
          const arg = args.join(' ').trim();
          if (arg) {
            const ok = await this.updateSetting('gatewayModel', arg);
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: ok
                ? `✅ Model set to \`${arg}\``
                : `🔄 Requested switching model to \`${arg}\`.\n\n*Note:* the gateway does not expose a persisted model-write endpoint yet — please update the model in settings.`,
              parseMode: 'Markdown',
            });
          } else {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: `*Current Model*\n\n\`${model ?? 'default'}\`\n\nUsage: \`/model [provider:model]\``,
              parseMode: 'Markdown',
            });
          }
          return true;
        }

        case 'provider': {
          const { model } = await this.getModelInfo();
          const provider = model && model.includes(':') ? model.split(':')[0] : 'default';
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: `*Current Provider*\n\n\`${provider}\``,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'reasoning': {
          const display = resolveDisplayConfig(msg.platform);
          const arg = args[0]?.toLowerCase();
          if (arg === 'on' || arg === 'off' || arg === 'toggle') {
            const ok = await this.updateSetting('display.reasoning', arg === 'on');
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: ok
                ? `✅ Reasoning \`${arg === 'on' ? 'enabled' : 'disabled'}\``
                : `🔄 Toggle requested (\`${arg}\`). *Note:* reasoning display is configured in settings; the gateway cannot persist it directly. Currently \`${display.showReasoning ? 'on' : 'off'}\`.`,
              parseMode: 'Markdown',
            });
          } else {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: `*Reasoning*\n\nCurrently: \`${display.showReasoning ? 'on' : 'off'}\`\n\nUsage: \`/reasoning [on|off|toggle]\``,
              parseMode: 'Markdown',
            });
          }
          return true;
        }

        case 'retry': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '`/retry` 当前未启用 — resending the last message is not wired up in this gateway build.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'undo': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '`/undo` 当前未启用 — removing the last exchange is not supported by this gateway build.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'stop': {
          const sessionId = await this.getSessionId(msg);
          if (sessionId) {
            this.streamHandler.cleanupStream(sessionId);
            // Forward an interrupt signal so the worker can kill running
            // terminal commands / cancel pending tool calls (Hermes semantics).
            this.ipc.interruptSession(sessionId);
          }
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: sessionId
              ? `⏹ Stopped the current stream for session \`${sessionId}\`.`
              : '⏹ No active session to stop.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'save': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '`/save` 当前未启用 — no explicit session-save endpoint is wired up in this gateway build.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'sessions': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '`/sessions` 当前未启用 — session listing is not exposed through the gateway IPC surface.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'resume': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '`/resume` 当前未启用 — resuming a past session is not exposed through the gateway IPC surface.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'history': {
          const sessionId = await this.getSessionId(msg);
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: sessionId
              ? `*Session History*\n\nSession: \`${sessionId}\`\n\nHistory summary is not available — the gateway does not expose message listing.`
              : 'No active session.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'title': {
          const name = args.join(' ').trim();
          const sessionId = await this.getSessionId(msg);
          if (!name) {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: 'Usage: `/title <name>` — set the session title.',
              parseMode: 'Markdown',
            });
          } else if (!sessionId) {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: 'No active session to title.',
            });
          } else {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: '`/title` 当前未启用 — setting the session title is not wired up in this gateway build.',
              parseMode: 'Markdown',
            });
          }
          return true;
        }

        case 'sethome': {
          const ok = await this.updateSetting('telegram_home_channel', msg.platformChatId);
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: ok
              ? `🏠 Home channel set to \`${msg.platformChatId}\`.`
              : `🔄 Requested setting home channel to \`${msg.platformChatId}\`. *Note:* the gateway cannot persist it directly; store \`telegram_home_channel\` in settings.`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'commands': {
          const all = getAllCommands();
          const lines = all.map((c) => {
            const usage = c.argsHint ? ` ${c.argsHint}` : '';
            return `- \`/${c.name}${usage}\` — ${c.description}`;
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: `*All Commands (${all.length})*\n\n${lines.join('\n')}`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'whoami': {
          const opts = (this.adapterConfigs.get(msg.platform)?.options ?? {}) as {
            allow_from?: string[];
            allow_admin_from?: string[];
            group_allow_from?: string[];
            group_allow_admin_from?: string[];
            free_response_chats?: string[];
          };
          const userId = msg.platformUserId;
          const chatId = msg.platformChatId;

          // Tier resolution (admin / user / unrestricted):
          //  - admins: explicitly listed in allow_from / allow_admin_from
          //    (or group_allow_admin_from) may run every command.
          //  - unrestricted: sender is in free_response_chats, or no allow-list
          //    is configured at all (default open).
          //  - user: every other authorized sender.
          let tier: string;
          const hasTailored =
            opts.allow_from?.length ||
            opts.allow_admin_from?.length ||
            opts.group_allow_from?.length ||
            opts.group_allow_admin_from?.length;
          if (
            opts.allow_from?.includes(userId) ||
            opts.allow_admin_from?.includes(userId) ||
            opts.group_allow_admin_from?.includes(userId)
          ) {
            tier = 'admin';
          } else if (!hasTailored || opts.free_response_chats?.includes(chatId)) {
            tier = hasTailored ? 'user' : 'unrestricted';
          } else {
            tier = 'user';
          }

          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: [
              '*Who am I*',
              '',
              `Platform: ${msg.platform}`,
              `User ID: \`${msg.platformUserId}\``,
              `Chat ID: \`${msg.platformChatId}\``,
              `Tier: \`${tier}\``,
              '',
              tier === 'admin' || tier === 'unrestricted'
                ? 'Permission: all commands.'
                : 'Permission: /help, /whoami, and any user-allowed commands.',
            ].join('\n'),
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'usage': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '`/usage` 当前未启用 — context/usage accounting is not exposed by this gateway build.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'compress': {
          // Hermes semantics: /compress here [N] — compress last N turns;
          // /compress focus <topic> — compress focusing on a topic.
          const target = args.join(' ');
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('compress', args, {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: target
              ? `🔄 已请求压缩 (target: \`${target}\`) — context compression is forwarded to the worker; results arrive asynchronously.`
              : `🔄 已请求压缩 — context compression is forwarded to the worker; results arrive asynchronously.`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'approve': {
          this.ipc.resolvePermissionByCommand('allow');
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '✅ 已批准待处理的权限请求。',
          });
          return true;
        }

        case 'deny': {
          this.ipc.resolvePermissionByCommand('deny');
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '❌ 已拒绝待处理的权限请求。',
          });
          return true;
        }

        case 'personality': {
          const name = args.join(' ').trim();
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('personality', name ? [name] : [], {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: name
              ? `🎭 已请求将 personality 设为 \`${name}\` — forwarded to the worker.`
              : `🎭 已请求读取当前 personality — forwarded to the worker.`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'voice': {
          const mode = args[0];
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('voice', mode ? [mode] : [], {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: mode
              ? `🔊 已请求 voice 模式 \`${mode}\` — forwarded to the worker.`
              : `🔊 已请求查询 voice 状态 — forwarded to the worker.`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'fast': {
          const mode = args[0];
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('fast', mode ? [mode] : [], {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: mode
              ? `⚡ 已请求 fast mode \`${mode}\` — forwarded to the worker.`
              : `⚡ 已请求查询 fast mode 状态 — forwarded to the worker.`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'verbose': {
          const mode = args[0];
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('verbose', mode ? [mode] : [], {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: mode
              ? `🔍 已请求 verbose \`${mode}\` — forwarded to the worker.`
              : `🔍 已请求查询 verbose 状态 — forwarded to the worker.`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'background': {
          const prompt = args.join(' ').trim();
          if (!prompt) {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: 'Usage: `/background <prompt>` — run in a separate background session.',
            });
            return true;
          }
          const sessionId = await this.getSessionId(msg);
          this.ipc.send({
            type: 'gateway:inbound',
            sessionId: sessionId ?? msg.platformUserId,
            prompt,
            platform: msg.platform,
            platformMsgId: msg.platformMsgId,
            platformChatId: msg.platformChatId,
            options: { background: true },
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: `⏳ 已在后台会话执行：\`${prompt}\` — 完成后会在这里通知你。`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'steer': {
          const prompt = args.join(' ').trim();
          if (!prompt) {
            await adapter.sendReply(msg.platformChatId, {
              type: 'text',
              text: 'Usage: `/steer <message>` — inject a message into the current run.',
            });
            return true;
          }
          const sessionId = await this.getSessionId(msg);
          this.ipc.send({
            type: 'gateway:inbound',
            sessionId: sessionId ?? msg.platformUserId,
            prompt,
            platform: msg.platform,
            platformMsgId: msg.platformMsgId,
            platformChatId: msg.platformChatId,
            options: { steer: true },
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: `⏩ 已注入当前运行：\`${prompt}\``,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'rollback': {
          const num = args[0];
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('rollback', num ? [num] : [], {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: num
              ? `↩️ 已请求回滚到检查点 \`${num}\` — forwarded to the worker.`
              : `↩️ 已请求列出文件系统检查点 — forwarded to the worker.`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'reload-mcp': {
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('reload-mcp', [], {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '🔄 已请求重载 MCP servers — forwarded to the worker.',
          });
          return true;
        }

        case 'update': {
          const sessionId = await this.getSessionId(msg);
          this.ipc.forwardCommand('update', args, {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '🔄 已请求检查更新 — forwarded to the worker.',
          });
          return true;
        }

        case 'delete': {
          const sessionId = await this.getSessionId(msg);
          if (sessionId) {
            this.streamHandler.cleanupStream(sessionId);
          }
          const { newSessionId } = await this.resetSession(msg);
          const sessionId2 = sessionId ?? '(none)';
          this.ipc.forwardCommand('delete', [], {
            sessionId: sessionId ?? undefined,
            platform: msg.platform,
            platformChatId: msg.platformChatId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: `🗑️ 已删除会话 \`${sessionId2}\` 并开启新会话 \`${newSessionId}\`。`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'clear': {
          const { newSessionId } = await this.resetSession(msg);
          const { model } = await this.getModelInfo();
          const lines = ['🧹 Screen cleared — new session started.', `Session: \`${newSessionId}\``];
          if (model) {
            lines.push(`Model: \`${model}\``);
          }
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: lines.join('\n\n'),
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'profile': {
          const route = matchProfileRoute(this.profileRoutes, {
            platform: msg.platform,
            chatId: msg.platformChatId,
            threadId: msg.threadId,
          });
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: [
              '*Profile*',
              '',
              `Profile: \`${route?.profile ?? 'default'}\``,
              `Chat: \`${msg.platformChatId}\``,
            ].join('\n'),
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'position': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: '`/position` 当前未启用 — context cursor tracking is not exposed by this gateway build.',
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'insights': {
          const days = args[0] ?? '7';
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: `\`/insights\` 当前未启用 — usage insights have no backing data source in this gateway build (days: \`${days}\`).`,
            parseMode: 'Markdown',
          });
          return true;
        }

        case 'about': {
          await adapter.sendReply(msg.platformChatId, {
            type: 'text',
            text: [
              '*DUYA Gateway*',
              '',
              'A multi-platform IM gateway connecting Telegram / Feishu / WeChat / QQ and more to a DUYA agent.',
              '',
              'Type `/help` to see all available commands.',
            ].join('\n'),
            parseMode: 'Markdown',
          });
          return true;
        }

        default:
          // Command is known but has no local handler - pass to agent
          return false;
      }
    } catch (err) {
      console.error('[GatewayManager] Error handling command:', err);
      await adapter.sendReply(msg.platformChatId, {
        type: 'error',
        message: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return true;
    }
  }
}

/**
 * Infer the channel MediaReply mediaType from a file extension. Mirrors the
 * outbound stream handler's inference (`stream-handler.ts`).
 */
function inferMediaType(filePath: string): MediaReply['mediaType'] {
  const ext = extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
    return 'photo';
  }
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext)) {
    return 'video';
  }
  if (['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac'].includes(ext)) {
    return 'voice';
  }
  return 'document';
}
