/**
 * Channel system types — shared between electron main and agent subprocess.
 *
 * These types are intentionally **pure** (no Electron imports) so they can be
 * used in both processes without pulling in heavy dependencies.
 *
 * Channel system overview (plan 488):
 * - A "channel" is an external messaging platform (Discord, Slack, etc.) bound
 *   to a bot (agent).  Each agent can have multiple channels.
 * - Incoming messages from a channel wake the agent with a `[inbound]` cue.
 * - Outgoing messages are delivered via SendMessage with a `channel` field.
 */

// =============================================================================
// Platform
// =============================================================================

/** Canonical platform identifiers. */
export const KNOWN_PLATFORMS = ['discord', 'slack', 'telegram', 'feishu', 'weixin'] as const;
export type KnownPlatform = typeof KNOWN_PLATFORMS[number];

/**
 * A single credential field the user must supply to bind a platform.
 * Most platforms need one field ("token"); Feishu needs appId+appSecret so the
 * manifest carries an explicit per-platform field list.
 */
export interface ConnectorCredentialField {
  /** Secret-store key (e.g. "token", "appId", "appSecret", "botToken"). */
  field: string;
  /** Human-readable label shown in the bind UI. */
  label: string;
  /** Rendered as a masked input. */
  secret: boolean;
  /** Whether the value is required to bind (ilinkBotId for weixin is optional). */
  required?: boolean;
}

/**
 * Manifest entry describing a connector platform.
 * Used by the UI to render the "add channel" picker.
 */
export interface ConnectorManifest {
  platform: string;
  displayName: string;
  blurb: string;
  /** Human-readable label for the primary credential field, e.g. "Bot Token" */
  credentialLabel: string;
  /** Per-field credential requirements. Defaults to a single "token" field. */
  credentialFields?: ConnectorCredentialField[];
  availability: 'available' | 'coming-soon';
  /** Optional markdown guide for obtaining credentials */
  connectGuide?: string;
}

/** Resolve a manifest's credential fields, defaulting to a single `token`. */
export function manifestCredentialFields(m: ConnectorManifest): ConnectorCredentialField[] {
  return (
    m.credentialFields ?? [
      { field: 'token', label: m.credentialLabel, secret: true, required: true },
    ]
  );
}

/** All currently registered connector manifests. */
export const CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = [
  {
    platform: 'discord',
    displayName: 'Discord',
    blurb: 'Connect a Discord bot to receive and reply to messages in servers and DMs.',
    credentialLabel: 'Bot Token',
    availability: 'available',
    connectGuide:
      'Create a Discord application at https://discord.com/developers/applications, ' +
      'add a Bot token, and enable Message Content Intent.',
  },
  {
    platform: 'slack',
    displayName: 'Slack',
    blurb: 'Connect a Slack workspace app to receive and reply to messages in channels.',
    credentialLabel: 'Bot Token',
    availability: 'available',
    connectGuide:
      'Create a Slack app at https://api.slack.com/apps, enable Bot Token Scopes ' +
      '(chat:write, channels:history, groups:history, im:history, mpim:history), ' +
      'and install to your workspace.',
  },
  {
    platform: 'telegram',
    displayName: 'Telegram',
    blurb: 'Connect a Telegram bot to receive and reply to messages in chats via long polling.',
    credentialLabel: 'Bot Token',
    availability: 'available',
    connectGuide:
      'Create a bot with @BotFather on Telegram, then paste the bot token here.',
  },
  {
    platform: 'feishu',
    displayName: 'Feishu',
    blurb: 'Connect a Feishu (Lark) bot app to receive and reply to messages via WebSocket gateway.',
    credentialLabel: 'App ID',
    credentialFields: [
      { field: 'appId', label: 'App ID', secret: true, required: true },
      { field: 'appSecret', label: 'App Secret', secret: true, required: true },
    ],
    availability: 'available',
    connectGuide:
      'Create an app in the Feishu open platform (https://open.feishu.cn), enable ' +
      'im:message event + im:message:send permissions, then paste the App ID and App Secret.',
  },
  {
    platform: 'weixin',
    displayName: 'WeChat',
    blurb: 'Connect a WeChat iLink bot to receive and reply to messages via long polling.',
    credentialLabel: 'Bot Token',
    credentialFields: [
      { field: 'botToken', label: 'Bot Token', secret: true, required: true },
      { field: 'ilinkBotId', label: 'iLink Bot ID (optional)', secret: false, required: false },
    ],
    availability: 'available',
    connectGuide:
      'Register a WeChat iLink bot for the account you want, then paste its bot token ' +
      '(and, if given, the iLink bot id).',
  },
];

// =============================================================================
// Channel Address
// =============================================================================

/**
 * Uniquely identifies a specific chat context on a specific platform.
 *
 * Serialised form: `"platform:chat"` (e.g. `"slack:C12345"`, `"discord: guild=987:channel=654"`).
 * The `chat` segment format is platform-specific; we keep it opaque here.
 */
export interface ChannelAddress {
  readonly platform: string;
  readonly chat: string;
}

/**
 * Format a ChannelAddress to its string token form.
 * Use this instead of manual string拼接.
 */
export function formatChannelAddress(addr: ChannelAddress): string {
  return `${addr.platform}:${addr.chat}`;
}

/**
 * Parse a channel address token back into a ChannelAddress.
 * Returns null if the string is malformed (no `:` separator).
 */
export function parseChannelAddress(raw: string): ChannelAddress | null {
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) return null;
  return { platform: raw.slice(0, idx), chat: raw.slice(idx + 1) } as ChannelAddress;
}

/** True when the platform is a known (implemented) platform. */
export function isKnownPlatform(platform: string): platform is KnownPlatform {
  return (KNOWN_PLATFORMS as readonly string[]).includes(platform);
}

// =============================================================================
// Inbound / Outbound messages
// =============================================================================

/**
 * A reaction attached to a channel message.
 * When a reaction is present `text` may be empty.
 */
export interface ChannelReaction {
  readonly emoji: string;
  /**
   * If the platform exposes message quotes on reactions, this is the quoted text.
   * Null if the platform does not provide quoted-text with reactions.
   */
  readonly messageQuote: string | null;
}

/**
 * Envelope for an incoming message from a channel.
 * This is what gets passed to `BackgroundWakes.wakeForInbound()`.
 */
export interface ChannelInboundEnvelope {
  readonly address: ChannelAddress;
  /** Display name or username of the sender. */
  readonly sender: string;
  /** Message text. May be empty if only a reaction is present. */
  readonly text: string;
  /**
   * Optional reaction. When present, `text` may be empty — the reaction alone
   * constitutes the inbound event.
   */
  readonly reaction: ChannelReaction | null;
}

/**
 * A single outbound message segment sent to a channel via `channelDelivery`.
 */
export interface ChannelOutboundMessage {
  kind: 'text' | 'attachment';
  /** Text content. Required for `kind: 'text'`. */
  content?: string;
  /** URL for `kind: 'attachment'`. */
  url?: string;
  /** Caption for an attachment. */
  caption?: string;
}

/**
 * Secret request content — when the bot elicits a credential from the user.
 * Sent via SendMessage with type: 'secret-request'.
 *
 * Flow:
 * 1. Bot calls SendMessage({ type: 'secret-request', secret: { label, connector, field } })
 * 2. Renderer shows masked input dialog
 * 3. User enters secret → stored via `connector-secret-store`
 * 4. Bot receives ack: "Secret stored securely for <connector> <field>"
 */
export interface SecretRequestContent {
  readonly type: 'secret-request';
  readonly secret: {
    /** Human-readable label shown in the UI, e.g. "Discord Bot Token" */
    readonly label: string;
    /** Platform identifier, e.g. "discord" or "slack" */
    readonly connector: string;
    /** Credential field name, e.g. "token" or "api_key" */
    readonly field: string;
  };
}

/**
 * Delivery failure record queued for `[channel-delivery-failed]` wake.
 */
export interface DeliveryFailure {
  readonly sessionId: string;
  readonly address: ChannelAddress;
  readonly outbound: ChannelOutboundMessage;
  readonly reason: string;
  readonly failedAt: number; // Unix epoch ms
}

// =============================================================================
// Store schemas (file-based, JSON-on-disk)
// =============================================================================

/**
 * Written to `agents/<agentId>/channels/<platform>/connection.json`.
 * Contains only human-readable / display metadata — NO credentials.
 */
export interface ChannelConnectionConfig {
  /** Human-readable label shown in the UI, e.g. "My Discord Server" */
  label: string;
  /** ISO timestamp of when the channel was first connected. */
  connectedAt: string;
}

/**
 * Written to `agents/<agentId>/connector-secrets/<platform>.json`.
 * Contains sensitive credentials — NEVER exposed to the agent subprocess.
 */
export interface ConnectorSecretRecord {
  [field: string]: string;
}

// =============================================================================
// Channel Snapshot (for bot prompt context, plan 488 §3.8)
// =============================================================================

/**
 * Snapshot of a bot's channel for the prompt context (Plan 488 §3.8).
 * Populated by reading agents/<agentId>/channels/<platform>/connection.json.
 *
 * Note: `chat` is currently an empty string because the channel store
 * stores per-platform connections, not per-channel addresses. The chat
 * field will be populated when the channel address resolution is implemented.
 */
export interface ChannelSnapshot {
  readonly platform: string;
  /** Currently empty string — per-channel chat IDs are resolved at delivery time. */
  readonly chat: string;
  readonly label: string;
  readonly status: 'configured';
}
