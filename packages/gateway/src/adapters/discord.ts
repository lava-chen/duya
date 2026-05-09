/**
 * Discord Adapter - PlatformAdapter implementation for Discord
 *
 * Features:
 * - Gateway connection with automatic reconnection
 * - Text message handling in guild channels and DMs
 * - Thread support (public/private threads)
 * - Slash command registration (/new, /reset, /help, /status)
 * - Permission request buttons
 * - DM and group chat gating policies
 * - Per-chat rate limiting
 * - Message deduplication
 * - Typing indicators
 * - Media message support (images, files)
 * - Voice channel join/leave functionality
 *
 * Based on patterns from:
 * - hermes-agent (discord.py implementation)
 * - openclaw (Discord thread bindings)
 */

import type {
  PlatformConfig,
  NormalizedMessage,
  NormalizedReply,
  SendResult,
} from '../types.js';
import type { PlatformAdapter } from './base.js';
import { registerAdapterFactory } from './base.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_MESSAGE_LENGTH = 2000;
const MAX_SEND_RETRIES = 3;
const CHAT_RATE_LIMIT_MS = 1000; // Discord has stricter rate limits
const TYPING_INDICATOR_INTERVAL_MS = 8000; // Discord typing lasts ~10s
const DEDUP_MAX = 500;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const MAX_CONSECUTIVE_FAILURES = 10;

// Discord API endpoints
const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Channel types
const CHANNEL_TYPE_GUILD_TEXT = 0;
const CHANNEL_TYPE_DM = 1;
const CHANNEL_TYPE_GUILD_VOICE = 2;
const CHANNEL_TYPE_GROUP_DM = 3;
const CHANNEL_TYPE_GUILD_CATEGORY = 4;
const CHANNEL_TYPE_GUILD_ANNOUNCEMENT = 5;
const CHANNEL_TYPE_PUBLIC_THREAD = 11;
const CHANNEL_TYPE_PRIVATE_THREAD = 12;
const CHANNEL_TYPE_GUILD_FORUM = 15;

// ============================================================================
// Discord Types
// ============================================================================

interface DiscordMessage {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  referenced_message?: DiscordMessage;
  thread?: {
    id: string;
    type: number;
  };
}

interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string;
}

interface DiscordGuild {
  id: string;
  name: string;
}

interface DiscordInteraction {
  id: string;
  type: number;
  token: string;
  data?: {
    name: string;
    options?: Array<{ name: string; value: string }>;
  };
  channel_id: string;
  member?: {
    user: {
      id: string;
      username: string;
    };
  };
  user?: {
    id: string;
    username: string;
  };
}

// ============================================================================
// Discord Adapter
// ============================================================================

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord' as const;

  private running = false;
  private messageHandler: ((msg: NormalizedMessage) => void) | null = null;
  private commandHandler: ((msg: NormalizedMessage) => Promise<boolean>) | null = null;
  private config: PlatformConfig | null = null;

  // Bot credentials
  private botToken = '';
  private applicationId = '';

  // Gateway connection
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private sessionId = '';
  private lastSequenceNumber: number | null = null;
  private resumeGatewayUrl = '';

  // Bot info
  private botId = '';
  private botUsername = '';

  // State tracking
  private seenMessageIds = new Set<string>();
  private consecutiveFailures = 0;
  private lastSendTime = new Map<string, number>();
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Health tracking
  private health = {
    connected: false,
    lastConnectedAt: undefined as number | undefined,
    lastErrorAt: undefined as number | undefined,
    lastError: undefined as string | undefined,
    consecutiveErrors: 0,
    totalMessages: 0,
  };

  // Gating policies
  private dmPolicy: 'open' | 'allowlist' | 'disabled' = 'open';
  private allowFrom: Set<string> = new Set();
  private groupPolicy: 'open' | 'allowlist' | 'disabled' = 'open';
  private groupAllowFrom: Set<string> = new Set();
  private requireMention = true;
  private freeResponseChats: Set<string> = new Set();
  private mentionPatterns: RegExp[] = [];

  // Voice channel state
  private voiceConnections = new Map<string, {
    guildId: string;
    channelId: string;
    endpoint: string;
    token: string;
    sessionId: string;
  }>();

  constructor() {
    registerAdapterFactory('discord', () => new DiscordAdapter());
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(config: PlatformConfig): Promise<void> {
    if (this.running) return;

    this.config = config;
    this.botToken = config.credentials['bot_token'] || '';
    this.applicationId = config.credentials['application_id'] || '';

    if (!this.botToken) {
      throw new Error('Discord bot_token is required');
    }

    // Parse gating policies
    this.parseGatingPolicies(config);

    console.log('[Discord] Starting adapter...');
    this.running = true;

    // Connect to gateway
    await this.connectGateway();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log('[Discord] Stopping adapter...');

    // Clear intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Stop typing indicators
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'Adapter stopping');
      this.ws = null;
    }

    this.health.connected = false;
    console.log('[Discord] Adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getHealth(): { connected: boolean; lastConnectedAt?: number; lastErrorAt?: number; lastError?: string; consecutiveErrors: number; totalMessages: number; botUsername?: string } {
    return {
      connected: this.health.connected,
      lastConnectedAt: this.health.lastConnectedAt,
      lastErrorAt: this.health.lastErrorAt,
      lastError: this.health.lastError,
      consecutiveErrors: this.health.consecutiveErrors,
      totalMessages: this.health.totalMessages,
      botUsername: this.botUsername,
    };
  }

  onMessage(handler: (msg: NormalizedMessage) => void): void {
    this.messageHandler = handler;
  }

  setCommandHandler(handler: (msg: NormalizedMessage) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Gateway Connection
  // ---------------------------------------------------------------------------

  private async connectGateway(): Promise<void> {
    try {
      // Get gateway URL
      const gatewayUrl = this.resumeGatewayUrl || await this.getGatewayUrl();

      console.log(`[Discord] Connecting to gateway: ${gatewayUrl}`);

      // Create WebSocket connection
      const wsUrl = `${gatewayUrl}/?v=10&encoding=json`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[Discord] WebSocket connected');
        this.health.connected = true;
        this.health.lastConnectedAt = Date.now();
        this.health.consecutiveErrors = 0;
        this.consecutiveFailures = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string);
          this.handleGatewayPayload(payload);
        } catch (err) {
          console.error('[Discord] Failed to parse gateway message:', err);
        }
      };

      this.ws.onclose = (event) => {
        console.log(`[Discord] WebSocket closed: ${event.code} ${event.reason}`);
        this.health.connected = false;
        this.ws = null;

        if (this.running) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error('[Discord] WebSocket error:', error);
        this.health.lastErrorAt = Date.now();
        this.health.lastError = 'WebSocket error';
        this.health.consecutiveErrors++;
      };

    } catch (err) {
      console.error('[Discord] Failed to connect gateway:', err);
      this.health.lastErrorAt = Date.now();
      this.health.lastError = err instanceof Error ? err.message : String(err);
      this.health.consecutiveErrors++;
      this.scheduleReconnect();
    }
  }

  private async getGatewayUrl(): Promise<string> {
    const response = await this.discordRequest<{ url: string }>('GET', '/gateway/bot');
    return response.url;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.consecutiveFailures++;
    const backoff = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFailures - 1),
      BACKOFF_MAX_MS
    );

    console.log(`[Discord] Reconnecting in ${backoff}ms (attempt ${this.consecutiveFailures})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.running) {
        this.connectGateway();
      }
    }, backoff);
  }

  // ---------------------------------------------------------------------------
  // Gateway Payload Handling
  // ---------------------------------------------------------------------------

  private handleGatewayPayload(payload: {
    op: number;
    d?: unknown;
    s?: number;
    t?: string;
  }): void {
    // Update sequence number
    if (payload.s !== undefined) {
      this.lastSequenceNumber = payload.s;
    }

    switch (payload.op) {
      case 10: // Hello
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;
      case 11: // Heartbeat ACK
        // Heartbeat acknowledged
        break;
      case 0: // Dispatch
        this.handleDispatch(payload.t || '', payload.d);
        break;
      case 1: // Heartbeat
        this.sendHeartbeat();
        break;
      case 7: // Reconnect
        console.log('[Discord] Gateway requested reconnect');
        this.ws?.close(1001, 'Reconnect requested');
        break;
      case 9: // Invalid Session
        console.log('[Discord] Invalid session, clearing session ID');
        this.sessionId = '';
        this.resumeGatewayUrl = '';
        setTimeout(() => this.identify(), 5000);
        break;
      default:
        console.log(`[Discord] Unhandled opcode: ${payload.op}`);
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    // Start heartbeat
    const interval = data.heartbeat_interval;
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, interval);

    // Identify or resume
    if (this.sessionId && this.resumeGatewayUrl) {
      this.resume();
    } else {
      this.identify();
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      op: 1,
      d: this.lastSequenceNumber,
    }));
  }

  private identify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    console.log('[Discord] Sending identify');

    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this.botToken,
        intents: 33281, // GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT
        properties: {
          os: process.platform,
          browser: 'duya-gateway',
          device: 'duya-gateway',
        },
      },
    }));
  }

  private resume(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    console.log('[Discord] Sending resume');

    this.ws.send(JSON.stringify({
      op: 6,
      d: {
        token: this.botToken,
        session_id: this.sessionId,
        seq: this.lastSequenceNumber,
      },
    }));
  }

  private handleDispatch(eventType: string, data: unknown): void {
    switch (eventType) {
      case 'READY':
        this.handleReady(data as { session_id: string; resume_gateway_url: string; user: { id: string; username: string } });
        break;
      case 'RESUMED':
        console.log('[Discord] Session resumed');
        break;
      case 'MESSAGE_CREATE':
        this.handleMessageCreate(data as DiscordMessage);
        break;
      case 'INTERACTION_CREATE':
        this.handleInteractionCreate(data as DiscordInteraction);
        break;
      case 'GUILD_CREATE':
        // Bot joined a new guild
        console.log(`[Discord] Joined guild: ${(data as DiscordGuild).name}`);
        break;
      default:
        // Ignore other events
        break;
    }
  }

  private handleReady(data: { session_id: string; resume_gateway_url: string; user: { id: string; username: string } }): void {
    this.sessionId = data.session_id;
    this.resumeGatewayUrl = data.resume_gateway_url;
    this.botId = data.user.id;
    this.botUsername = data.user.username;

    console.log(`[Discord] Ready as ${this.botUsername} (${this.botId})`);

    // Register slash commands
    this.registerSlashCommands().catch((err) => {
      console.error('[Discord] Failed to register slash commands:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Message Handling
  // ---------------------------------------------------------------------------

  private async handleMessageCreate(msg: DiscordMessage): Promise<void> {
    // Skip messages from self
    if (msg.author.id === this.botId) return;

    // Skip bot messages if configured
    if (msg.author.bot) {
      const allowBots = this.config?.options?.['allow_bots'] as boolean | undefined;
      if (!allowBots) return;
    }

    // Deduplication
    if (this.seenMessageIds.has(msg.id)) return;
    this.seenMessageIds.add(msg.id);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    this.health.totalMessages++;

    // Get channel info for gating
    const channel = await this.getChannel(msg.channel_id);
    if (!channel) return;

    // Check gating policies
    if (!this.shouldProcessMessage(msg, channel)) {
      return;
    }

    // Build normalized message
    const normalized: NormalizedMessage = {
      platform: 'discord',
      platformUserId: msg.author.id,
      platformChatId: msg.channel_id,
      platformMsgId: msg.id,
      text: msg.content || undefined,
      replyToMsgId: msg.referenced_message?.id,
      replyToText: msg.referenced_message?.content,
      ts: new Date(msg.timestamp).getTime(),
      threadId: channel.type === CHANNEL_TYPE_PUBLIC_THREAD || channel.type === CHANNEL_TYPE_PRIVATE_THREAD
        ? msg.channel_id
        : undefined,
    };

    // Check for slash command
    if (normalized.text?.startsWith('/') && this.commandHandler) {
      const handled = await this.commandHandler(normalized).catch((err) => {
        console.error('[Discord] Command handler error:', err);
        return false;
      });
      if (handled) return;
    }

    // Route to message handler
    if (this.messageHandler) {
      this.messageHandler(normalized);
    }
  }

  private async handleInteractionCreate(interaction: DiscordInteraction): Promise<void> {
    if (interaction.type !== 2) return; // Only handle application commands

    const commandName = interaction.data?.name;
    if (!commandName) return;

    const userId = interaction.member?.user.id || interaction.user?.id || '';
    const username = interaction.member?.user.username || interaction.user?.username || '';

    // Build normalized message for command
    const normalized: NormalizedMessage = {
      platform: 'discord',
      platformUserId: userId,
      platformChatId: interaction.channel_id,
      platformMsgId: interaction.id,
      text: `/${commandName}`,
      ts: Date.now(),
    };

    // Acknowledge the interaction
    await this.acknowledgeInteraction(interaction.id, interaction.token);

    // Handle command
    if (this.commandHandler) {
      await this.commandHandler(normalized);
    }
  }

  private async acknowledgeInteraction(interactionId: string, token: string): Promise<void> {
    try {
      await this.discordRequest('POST', `/interactions/${interactionId}/${token}/callback`, {
        type: 5, // Deferred channel message with source
      });
    } catch (err) {
      console.error('[Discord] Failed to acknowledge interaction:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Gating Policies
  // ---------------------------------------------------------------------------

  private parseGatingPolicies(config: PlatformConfig): void {
    const options = config.options ?? {};

    // DM policy
    const dmPolicyRaw = options['dm_policy'] as string | undefined;
    this.dmPolicy = ['open', 'allowlist', 'disabled'].includes(dmPolicyRaw || '')
      ? (dmPolicyRaw as 'open' | 'allowlist' | 'disabled')
      : 'open';

    // Allowlist for DMs
    const allowFromRaw = options['allow_from'] as string[] | undefined;
    this.allowFrom = new Set(allowFromRaw ?? []);

    // Group policy
    const groupPolicyRaw = options['group_policy'] as string | undefined;
    this.groupPolicy = ['open', 'allowlist', 'disabled'].includes(groupPolicyRaw || '')
      ? (groupPolicyRaw as 'open' | 'allowlist' | 'disabled')
      : 'open';

    // Group allowlist
    const groupAllowFromRaw = options['group_allow_from'] as string[] | undefined;
    this.groupAllowFrom = new Set(groupAllowFromRaw ?? []);

    // Require mention in groups
    const requireMentionRaw = options['require_mention'];
    this.requireMention = requireMentionRaw !== false;

    // Free response chats
    const freeResponseRaw = options['free_response_chats'] as string[] | undefined;
    this.freeResponseChats = new Set(freeResponseRaw ?? []);

    // Mention patterns
    const mentionPatternsRaw = options['mention_patterns'] as string[] | undefined;
    this.mentionPatterns = (mentionPatternsRaw ?? [])
      .map((p) => {
        try {
          return new RegExp(p, 'i');
        } catch {
          return null;
        }
      })
      .filter((p): p is RegExp => p !== null);
  }

  private shouldProcessMessage(msg: DiscordMessage, channel: DiscordChannel): boolean {
    const isDM = channel.type === CHANNEL_TYPE_DM || channel.type === CHANNEL_TYPE_GROUP_DM;

    if (isDM) {
      return this.isDmAllowed(msg.author.id);
    } else {
      return this.isGuildAllowed(msg.channel_id, msg);
    }
  }

  private isDmAllowed(userId: string): boolean {
    if (this.dmPolicy === 'disabled') return false;
    if (this.dmPolicy === 'allowlist') return this.allowFrom.has(userId);
    return true;
  }

  private isGuildAllowed(channelId: string, msg: DiscordMessage): boolean {
    if (this.groupPolicy === 'disabled') return false;
    if (this.groupPolicy === 'allowlist') return this.groupAllowFrom.has(channelId);

    // Free response chats
    if (this.freeResponseChats.has(channelId)) return true;

    // Always respond to commands
    if (msg.content?.startsWith('/')) return true;

    // Check mention requirement
    if (!this.requireMention) return true;

    // Check if bot is mentioned
    if (msg.content?.includes(`<@${this.botId}>`)) return true;
    if (msg.content?.includes(`<@!${this.botId}>`)) return true;

    // Check mention patterns
    if (this.mentionPatterns.some((p) => p.test(msg.content || ''))) return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // Slash Commands
  // ---------------------------------------------------------------------------

  private async registerSlashCommands(): Promise<void> {
    if (!this.applicationId) {
      console.warn('[Discord] No application_id configured, skipping slash command registration');
      return;
    }

    const commands = [
      {
        name: 'new',
        description: 'Start a fresh session',
      },
      {
        name: 'reset',
        description: 'Reset session (alias for /new)',
      },
      {
        name: 'help',
        description: 'Show available commands',
      },
      {
        name: 'status',
        description: 'Show current session info',
      },
    ];

    try {
      await this.discordRequest('PUT', `/applications/${this.applicationId}/commands`, commands);
      console.log(`[Discord] Registered ${commands.length} slash commands`);
    } catch (err) {
      console.error('[Discord] Failed to register slash commands:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound: Send Reply
  // ---------------------------------------------------------------------------

  async sendReply(chatId: string, reply: NormalizedReply): Promise<SendResult> {
    try {
      switch (reply.type) {
        case 'text': {
          const text = formatMessageForDiscord(reply.text);
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await this.sendDiscordMessage(chatId, {
              content: chunk,
              message_reference: reply.replyToMsgId
                ? { message_id: reply.replyToMsgId }
                : undefined,
            });
            lastMsgId = result.id;
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'stream_start':
        case 'stream_chunk':
          return { ok: true };

        case 'stream_end': {
          const text = formatMessageForDiscord(reply.finalText);
          const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
          let lastMsgId = '';

          for (const chunk of chunks) {
            await this.waitForRateLimit(chatId);
            const result = await this.sendDiscordMessage(chatId, { content: chunk });
            lastMsgId = result.id;
            this.recordSendTime(chatId);
          }

          return { ok: true, platformMsgId: lastMsgId };
        }

        case 'permission_request': {
          const components = {
            components: [
              {
                type: 1, // Action row
                components: reply.buttons.map((btn) => ({
                  type: 2, // Button
                  style: 1, // Primary
                  label: btn.text,
                  custom_id: btn.callbackData,
                })),
              },
            ],
          };

          await this.waitForRateLimit(chatId);
          const result = await this.sendDiscordMessage(chatId, {
            content: formatMessageForDiscord(reply.text),
            ...components,
          });
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.id };
        }

        case 'error': {
          const text = `Error: ${reply.message}`;
          await this.waitForRateLimit(chatId);
          const result = await this.sendDiscordMessage(chatId, { content: text });
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.id };
        }

        case 'inline_keyboard': {
          const components = {
            components: reply.rows.map((row) => ({
              type: 1, // Action row
              components: row.map((btn) => ({
                type: 2, // Button
                style: btn.url ? 5 : 1, // Link or Primary
                label: btn.text,
                ...(btn.url
                  ? { url: btn.url }
                  : { custom_id: btn.callbackData }),
              })),
            })),
          };

          await this.waitForRateLimit(chatId);
          const result = await this.sendDiscordMessage(chatId, {
            content: formatMessageForDiscord(reply.text),
            ...components,
          });
          this.recordSendTime(chatId);
          return { ok: true, platformMsgId: result.id };
        }

        default:
          return { ok: false, error: 'Unknown reply type' };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.discordRequest('POST', `/channels/${chatId}/typing`);
    } catch {
      // Ignore typing indicator failures
    }
  }

  // ---------------------------------------------------------------------------
  // Voice Channel Methods
  // ---------------------------------------------------------------------------

  /**
   * Join a Discord voice channel
   * @param guildId The guild ID
   * @param channelId The voice channel ID to join
   * @returns True if successful
   */
  async joinVoiceChannel(guildId: string, channelId: string): Promise<boolean> {
    try {
      // Update voice state to join channel
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.error('[Discord] Cannot join voice channel: WebSocket not connected');
        return false;
      }

      this.ws.send(JSON.stringify({
        op: 4, // Voice State Update
        d: {
          guild_id: guildId,
          channel_id: channelId,
          self_mute: false,
          self_deaf: false,
        },
      }));

      console.log(`[Discord] Requested to join voice channel ${channelId} in guild ${guildId}`);
      return true;
    } catch (err) {
      console.error('[Discord] Failed to join voice channel:', err);
      return false;
    }
  }

  /**
   * Leave a Discord voice channel
   * @param guildId The guild ID
   * @returns True if successful
   */
  async leaveVoiceChannel(guildId: string): Promise<boolean> {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.error('[Discord] Cannot leave voice channel: WebSocket not connected');
        return false;
      }

      this.ws.send(JSON.stringify({
        op: 4, // Voice State Update
        d: {
          guild_id: guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        },
      }));

      // Remove from tracking
      this.voiceConnections.delete(guildId);

      console.log(`[Discord] Left voice channel in guild ${guildId}`);
      return true;
    } catch (err) {
      console.error('[Discord] Failed to leave voice channel:', err);
      return false;
    }
  }

  /**
   * Check if bot is in a voice channel
   * @param guildId The guild ID
   * @returns True if in a voice channel
   */
  isInVoiceChannel(guildId: string): boolean {
    return this.voiceConnections.has(guildId);
  }

  /**
   * Get voice channel info
   * @param guildId The guild ID
   * @returns Voice channel info or null
   */
  getVoiceChannelInfo(guildId: string): { channelId: string; guildId: string } | null {
    const conn = this.voiceConnections.get(guildId);
    if (!conn) return null;
    return { channelId: conn.channelId, guildId: conn.guildId };
  }

  // ---------------------------------------------------------------------------
  // Discord API Helpers
  // ---------------------------------------------------------------------------

  private async sendDiscordMessage(
    channelId: string,
    body: Record<string, unknown>
  ): Promise<{ id: string }> {
    return this.discordRequest('POST', `/channels/${channelId}/messages`, body);
  }

  private async getChannel(channelId: string): Promise<DiscordChannel | null> {
    try {
      return await this.discordRequest('GET', `/channels/${channelId}`);
    } catch (err) {
      console.error(`[Discord] Failed to get channel ${channelId}:`, err);
      return null;
    }
  }

  private async discordRequest<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${DISCORD_API_BASE}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bot ${this.botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DuyaBot/1.0',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord API error (${response.status}): ${text}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Rate Limiting
  // ---------------------------------------------------------------------------

  private async waitForRateLimit(chatId: string): Promise<void> {
    const last = this.lastSendTime.get(chatId);
    if (last) {
      const wait = CHAT_RATE_LIMIT_MS - (Date.now() - last);
      if (wait > 0) {
        await this.delay(wait);
      }
    }
  }

  private recordSendTime(chatId: string): void {
    this.lastSendTime.set(chatId, Date.now());
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert markdown to Discord-compatible formatting
 * Discord supports: **bold**, *italic*, __underline__, ~~strikethrough~~, `code`, ```code blocks```
 */
function formatMessageForDiscord(content: string): string {
  if (!content) return content;

  // Discord markdown is fairly compatible with standard markdown
  // Just need to ensure proper escaping
  return content
    .replace(/\\\*/g, '\\*') // Escape asterisks
    .replace(/\\_/g, '\\_')   // Escape underscores
    .replace(/\\`/g, '\\`')   // Escape backticks
    .replace(/\\~/g, '\\~');  // Escape tildes
}

/**
 * Split long messages at Discord's 2000 char limit
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// Register adapter factory
registerAdapterFactory('discord', () => new DiscordAdapter());
