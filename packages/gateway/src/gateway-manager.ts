/**
 * GatewayManager - Orchestrates platform adapters and message routing
 *
 * Lifecycle:
 * 1. Receive init config from Main Process
 * 2. Start enabled adapters in parallel with independent timeouts
 * 3. Route inbound messages → Main Process (via IPC, allow-list verdict awaited)
 * 4. Route outbound messages → Platform adapters
 *
 * Plan 520: no session mapping (user-mapper removed — Main resolves sessions),
 * no local command execution (detected commands are wrapped and passed
 * through), no permission flow, and busy queue/steer/interrupt is decided per
 * adapter from Main's `gateway:agent_busy` broadcast.
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
import { basename, extname } from 'node:path';
import { PlatformAdapter, createAdapter } from './adapters/base.js';
import { IpcClient } from './ipc-client.js';
import { matchProfileRoute, parseProfileRoutes, type ProfileRoute } from './profile-routing.js';
import { setProxyUrl, initProxy } from './proxy-fetch.js';
import { EXT_MIME_MAP, MIME_EXT_MAP } from './utils/mime.js';
import { readFile } from 'node:fs/promises';
import { detectCommand } from './commands/dispatcher.js';

const ADAPTER_START_TIMEOUT_MS = 30_000;
const ADAPTER_STOP_TIMEOUT_MS = 10_000;

/**
 * Build the inbound `options.files` payload (GatewayFileAttachment[]) from a
 * NormalizedMessage. Inlined from the old `attachment-builder.ts` because the
 * gateway is now its only consumer and the file was a 187-line wrapper around
 * the same reductions + size guards.
 */
interface GatewayFileAttachment {
  id?: string;
  name: string;
  type: string;
  url: string;
  size: number;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_VIDEO_BYTES = 25 * 1024 * 1024;

const IMAGE_MAGIC_BYTES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'image/bmp': [0x42, 0x4d],
};

function getMimeByExtension(filePath?: string): string | null {
  if (!filePath) return null;
  const ext = extname(filePath).toLowerCase();
  return EXT_MIME_MAP[ext] || null;
}

function detectMimeType(buffer: Buffer, filePath?: string): string | null {
  for (const [mime, magic] of Object.entries(IMAGE_MAGIC_BYTES)) {
    const matches = magic.every((byte, i) => buffer[i] === byte);
    if (matches) return mime;
  }
  return getMimeByExtension(filePath);
}

function ensureExtension(name: string, mimeType: string): string {
  const existingExt = extname(name).toLowerCase();
  if (existingExt) return name;
  const ext = MIME_EXT_MAP[mimeType];
  return ext ? `${name}${ext}` : name;
}

function bufferToAttachment(
  buffer: Buffer,
  name: string,
  filePath?: string,
): GatewayFileAttachment {
  const mimeType = detectMimeType(buffer, filePath) || 'application/octet-stream';
  const base64 = buffer.toString('base64');
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    name: ensureExtension(name, mimeType),
    type: mimeType,
    url: `data:${mimeType};base64,${base64}`,
    size: buffer.length,
  };
}

async function readFileToAttachment(
  filePath: string,
  name?: string,
  maxSize: number = MAX_DOC_BYTES,
): Promise<GatewayFileAttachment | null> {
  try {
    const buffer = await readFile(filePath);
    if (buffer.length > maxSize) {
      console.warn(
        `[GatewayManager] Skipping large file: ${filePath} ` +
          `(${(buffer.length / (1024 * 1024)).toFixed(1)} MB > ${(maxSize / (1024 * 1024)).toFixed(1)} MB)`,
      );
      return null;
    }
    const fileName = name || filePath.split(/[/\\]/).pop() || 'file';
    return bufferToAttachment(buffer, fileName, filePath);
  } catch (err) {
    console.warn(`[GatewayManager] Failed to read file: ${filePath}`, err);
    return null;
  }
}

async function buildInboundFiles(msg: NormalizedMessage): Promise<GatewayFileAttachment[]> {
  const out: GatewayFileAttachment[] = [];

  for (let i = 0; i < (msg.images?.length ?? 0); i++) {
    const buffer = msg.images![i];
    if (buffer.length > MAX_IMAGE_BYTES) {
      console.warn(`[GatewayManager] Skipping large image buffer #${i + 1}`);
      continue;
    }
    out.push(bufferToAttachment(buffer, `image-${i + 1}.jpg`));
  }

  for (let i = 0; i < (msg.imagePaths?.length ?? 0); i++) {
    const att = await readFileToAttachment(msg.imagePaths![i], `image-${i + 1}`, MAX_IMAGE_BYTES);
    if (att) out.push(att);
  }

  for (let i = 0; i < (msg.files?.length ?? 0); i++) {
    const f = msg.files![i];
    if (f.buffer.length > MAX_DOC_BYTES) {
      console.warn(`[GatewayManager] Skipping large file: ${f.name}`);
      continue;
    }
    out.push(bufferToAttachment(f.buffer, f.name));
  }

  for (let i = 0; i < (msg.filePaths?.length ?? 0); i++) {
    const f = msg.filePaths![i];
    const att = await readFileToAttachment(f.path, f.name, MAX_DOC_BYTES);
    if (att) out.push(att);
  }

  for (let i = 0; i < (msg.voicePaths?.length ?? 0); i++) {
    const att = await readFileToAttachment(msg.voicePaths![i], `voice-${i + 1}`, MAX_AUDIO_VIDEO_BYTES);
    if (att) out.push(att);
  }

  for (let i = 0; i < (msg.videoPaths?.length ?? 0); i++) {
    const att = await readFileToAttachment(msg.videoPaths![i], `video-${i + 1}`, MAX_AUDIO_VIDEO_BYTES);
    if (att) out.push(att);
  }

  return out;
}

/**
 * Plain-path inbound attachment reference (plan 507 P2.2).
 *
 * Carries the adapter's local cache path (and best-known name) alongside the
 * base64 `options.files` payload so the main process can persist the file to
 * stable storage for the wake prompt without re-downloading it.
 */
export interface InboundAttachmentRef {
  name: string;
  path: string;
}

/** Per-chat working-reaction bookkeeping (bot-status signal, plan 520). */
interface PendingReactionState {
  count: number;
  lastMsgId?: string;
}

export class GatewayManager {
  private running = false;
  private adapters = new Map<PlatformType, PlatformAdapter>();
  private adapterConfigs = new Map<PlatformType, PlatformConfig>();
  private ipc: IpcClient;
  private profileRoutes: ProfileRoute[] = [];
  private autoStart = false;
  private proxyConfig?: GatewayProxyConfig;
  /** Busy flag per (platform:chatId), driven by Main's agent_busy broadcast. */
  private agentBusyByChat = new Map<string, boolean>();
  /** queue-mode inbound buffer per (platform:chatId) while the agent is busy. */
  private messageQueue = new Map<string, NormalizedMessage[]>();
  /** Working-reaction state per (platform:chatId): in-flight wake count + last inbound msg id. */
  private pendingByChat = new Map<string, PendingReactionState>();

  constructor() {
    this.ipc = new IpcClient();
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
        this.adapterConfigs.set(platformConfig.platform, {
          platform: platformConfig.platform,
          credentials: platformConfig.credentials,
          options: platformConfig.options,
          useProxy,
        });
      }
    }

    console.log(`[GatewayManager] Init complete, autoStart=${this.autoStart}, platforms=${this.adapterConfigs.size}`);
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
          // Adapters invoke the command handler for '/'-prefixed texts and
          // fall back to onMessage when it reports "not handled". The gateway
          // now treats both uniformly (command detection lives inside
          // handleInboundMessage), so always claim the message here.
          adapter.setCommandHandler(async (msg) => {
            await this.handleInboundMessage(msg);
            return true;
          });

          if ('getIpcClient' in adapter) {
            (adapter as { getIpcClient?: () => IpcClient }).getIpcClient = () => this.ipc;
          }

          await Promise.race([
            adapter.start(config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Adapter start timeout after ${ADAPTER_START_TIMEOUT_MS}ms`)), ADAPTER_START_TIMEOUT_MS)
            ),
          ]);

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
  }

  /**
   * Stop all adapters in parallel.
   * Each adapter stops independently with its own timeout.
   */
  async stop(): Promise<void> {
    console.log('[GatewayManager] Stopping adapters in parallel...');

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

    this.adapters.clear();
    this.agentBusyByChat.clear();
    this.messageQueue.clear();
    this.pendingByChat.clear();
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
      adapters.push({
        platform,
        running: adapter.isRunning(),
        health,
      });
    }

    // Include configured but not started adapters
    for (const platform of this.adapterConfigs.keys()) {
      if (!this.adapters.has(platform)) {
        adapters.push({
          platform,
          running: false,
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
   * Handle an outbound delivery from the Main Process.
   *
   * The gateway no longer runs a streaming card manager; the main process
   * aggregates the agent's stream into a discrete NormalizedReply (text, media,
   * or a card) and pushes one final delivery through this entry. Any sub-final
   * events are no-ops — the gateway does not own a stream state machine.
   *
   * Plan 520: session→chat resolution happens Main-side (user-mapper removed),
   * so only the direct platform/chatId form is routable.
   */
  async handleOutboundEvent(
    sessionId: string,
    event: StreamEvent,
    directPlatform?: string,
    directPlatformChatId?: string
  ): Promise<void> {
    // Tool progress / status / thinking / permission events are handled by
    // the main process renderer; the channel-only gateway only delivers
    // terminal replies (`chat:text` / `chat:done` / `chat:error`).
    const isTerminal =
      event.type === 'chat:text' ||
      event.type === 'chat:done' ||
      event.type === 'chat:error';
    if (!isTerminal) {
      return;
    }

    if (!directPlatform || !directPlatformChatId) {
      console.warn(`[GatewayManager] handleOutboundEvent: no platform/chat for session=${sessionId}`);
      return;
    }
    const adapter = this.adapters.get(directPlatform as PlatformType);
    if (!adapter) {
      console.warn(`[GatewayManager] handleOutboundEvent: no adapter for platform=${directPlatform}`);
      return;
    }

    const reply: NormalizedReply = event.type === 'chat:error'
      ? { type: 'text', text: event.message ?? '⚠️ agent error' }
      : { type: 'text', text: event.finalContent ?? event.content ?? '' };
    if (!reply.text) return;

    try {
      await adapter.sendReply(directPlatformChatId, reply);
    } catch (err) {
      console.error('[GatewayManager] handleOutboundEvent sendReply failed:', err);
    }

    this.clearWorkingReaction(directPlatform, directPlatformChatId, event.type !== 'chat:error');
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
   * Handle an agent busy/idle broadcast from Main (plan 520). Main resolves
   * the (platform, chatId) itself; the adapter decides queue/steer/interrupt
   * locally — here that means: buffer in queue mode, flush on idle, and
   * translate the terminal state into the bot-status reaction/typing signal.
   */
  handleAgentBusy(platform: string, platformChatId: string, busy: boolean, ok?: boolean): void {
    const key = `${platform}:${platformChatId}`;
    this.agentBusyByChat.set(key, busy);
    const adapter = this.adapters.get(platform as PlatformType);
    adapter?.onAgentBusy?.(busy);

    if (busy) return;

    // Idle: flush queue-mode buffers — each queued message re-enters the
    // normal inbound path.
    const queued = this.messageQueue.get(key);
    if (queued && queued.length > 0) {
      this.messageQueue.delete(key);
      for (const msg of queued) {
        void this.handleInboundMessage(msg);
      }
    }

    this.clearWorkingReaction(platform, platformChatId, ok !== false);
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

  // ---------------------------------------------------------------------------
  // Private: Inbound message handling
  // ---------------------------------------------------------------------------

  private async handleInboundMessage(msg: NormalizedMessage): Promise<void> {
    try {
      const adapter = this.adapters.get(msg.platform);
      const key = `${msg.platform}:${msg.platformChatId}`;
      const cmd = detectCommand(msg);

      // Busy-input handling (adapter-local, plan 520): when Main reports the
      // agent busy for this chat, honor the adapter's configured mode.
      const options: Record<string, unknown> = {};
      if (!cmd && this.agentBusyByChat.get(key) === true) {
        const mode = this.getBusyMode(msg.platform);
        if (mode === 'queue') {
          const queue = this.messageQueue.get(key) ?? [];
          queue.push(msg);
          this.messageQueue.set(key, queue);
          await adapter?.sendReply?.(msg.platformChatId, {
            type: 'text',
            text: '⏳ 正在处理上一条消息，已排队。',
          });
          return;
        }
        // steer / interrupt: expressed as inbound options so Main applies them
        // to the running wake (interrupt falls back to a plain wake when the
        // main process has no interrupt path for the session).
        if (mode === 'steer') options.steer = true;
        if (mode === 'interrupt') options.interrupt = true;
      }

      // Forward to Main and await the allow-list verdict. Main resolves (or
      // creates) the session, checks the channel allow-list, enqueues the
      // wake / executes the command, and replies `authorized`.
      const authorized = await this.forwardInbound(msg, cmd, options);

      if (!authorized) {
        await adapter?.sendReply?.(msg.platformChatId, {
          type: 'text',
          text: '⛔ 你还没有被授权使用这个 bot。请联系管理员在设置中添加你的用户 ID。',
        });
        return;
      }

      if (cmd) return;

      // Bot-status signal: show "working" on the user's message (hermes-style
      // reaction) plus a typing indicator; both clear when Main reports idle.
      this.trackWorkingReaction(msg);
      adapter?.sendTyping?.(msg.platformChatId)?.catch(() => {
        // Typing is best-effort.
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
   * Read the busy-input mode for a platform ('queue' | 'steer' | 'interrupt').
   * Defaults to 'queue' (Hermes default: acknowledge and enqueue).
   */
  private getBusyMode(platform: PlatformType): 'queue' | 'steer' | 'interrupt' {
    const opts = this.adapterConfigs.get(platform)?.options;
    const mode = (opts as { busy_input?: 'queue' | 'steer' | 'interrupt' } | undefined)?.busy_input;
    return mode ?? 'queue';
  }

  /** Mark the chat as having an in-flight wake and react 🤔 on the user's message. */
  private trackWorkingReaction(msg: NormalizedMessage): void {
    const key = `${msg.platform}:${msg.platformChatId}`;
    const pending = this.pendingByChat.get(key) ?? { count: 0 };
    pending.count += 1;
    if (msg.platformMsgId) pending.lastMsgId = msg.platformMsgId;
    this.pendingByChat.set(key, pending);

    const adapter = this.adapters.get(msg.platform);
    const reactionOpts = (this.adapterConfigs.get(msg.platform)?.options ?? {}) as
      { reactions?: { enabled?: boolean; working?: string } };
    const reactionsEnabled = reactionOpts.reactions?.enabled ?? true;
    const workingEmoji = reactionOpts.reactions?.working ?? '🤔';
    if (reactionsEnabled && msg.platformMsgId) {
      try {
        adapter?.setMessageReaction?.(msg.platformChatId, msg.platformMsgId, workingEmoji);
      } catch {
        // Reaction is best-effort.
      }
    }
  }

  /** Replace the working reaction with the terminal emoji and stop typing. */
  private clearWorkingReaction(platform: string, platformChatId: string, ok: boolean): void {
    const key = `${platform}:${platformChatId}`;
    const pending = this.pendingByChat.get(key);
    if (pending) {
      pending.count = Math.max(0, pending.count - 1);
      if (pending.count > 0) {
        // More wakes still in flight — keep the working state.
        return;
      }
      this.pendingByChat.delete(key);
    }

    const adapter = this.adapters.get(platform as PlatformType);
    adapter?.stopTyping?.(platformChatId);
    if (!pending?.lastMsgId) return;

    const opts = (this.adapterConfigs.get(platform as PlatformType)?.options ?? {}) as {
      reactions?: { enabled?: boolean; done?: string; error?: string };
    };
    const doneEmoji = ok
      ? (opts.reactions?.done ?? '👍')
      : (opts.reactions?.error ?? '👎');
    try {
      adapter?.setMessageReaction?.(platformChatId, pending.lastMsgId, doneEmoji);
    } catch {
      // Reaction updates are best-effort; never break the reply path on them.
    }
  }

  /**
   * Forward a normalized inbound message to Main as a `gateway:inbound`
   * request and await the allow-list verdict. Commands are wrapped as
   * `{ kind: 'command', command, args }` for Main-side execution.
   */
  private async forwardInbound(
    msg: NormalizedMessage,
    cmd: { command: string; args: string[] } | null,
    extraOptions: Record<string, unknown>,
  ): Promise<boolean> {
    const options: Record<string, unknown> = { ...extraOptions };

    // Base64 file payload for backward compat with main-process consumers.
    const files = await buildInboundFiles(msg);
    if (files.length > 0) {
      options.files = files;
    }

    // Plain-path attachment refs (plan 507 P2.2): parallel to the base64
    // `options.files` above (which stays for compat) — carries the adapter's
    // local cache paths so the main process can persist them to stable
    // storage for the wake prompt. Cache file names already carry their
    // extension, so basename preserves MIME-recognizable names.
    const attachmentRefs: InboundAttachmentRef[] = [];
    for (const p of msg.imagePaths ?? []) {
      if (p) attachmentRefs.push({ name: basename(p), path: p });
    }
    for (const f of msg.filePaths ?? []) {
      if (f.path) attachmentRefs.push({ name: f.name, path: f.path });
    }
    for (const p of msg.voicePaths ?? []) {
      if (p) attachmentRefs.push({ name: basename(p), path: p });
    }
    for (const p of msg.videoPaths ?? []) {
      if (p) attachmentRefs.push({ name: basename(p), path: p });
    }
    if (attachmentRefs.length > 0) {
      options.attachments = attachmentRefs;
    }

    // Profile routing: carry the resolved profile so the worker can use it.
    const route = matchProfileRoute(this.profileRoutes, {
      platform: msg.platform,
      chatId: msg.platformChatId,
      threadId: msg.threadId,
    });
    if (route && options.profile === undefined) {
      options.profile = route.profile;
    }

    const authorized = (await this.ipc.request('gateway:inbound', {
      kind: cmd ? 'command' : 'message',
      prompt: msg.text ?? '',
      platform: msg.platform,
      platformUserId: msg.platformUserId,
      platformMsgId: msg.platformMsgId,
      platformChatId: msg.platformChatId,
      ...(cmd ? { command: cmd.command, args: cmd.args } : {}),
      options,
    })) as boolean;

    return authorized === true;
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
