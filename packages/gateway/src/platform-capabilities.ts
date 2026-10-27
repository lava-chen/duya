/**
 * Platform capability matrix.
 *
 * One declarative table describing, for every supported IM channel: how it
 * receives messages, which credential fields it needs, how long a single
 * message may be, and which outbound/inbound features it actually supports.
 *
 * Why a table instead of per-adapter ad-hoc checks:
 * - The gateway issues best-effort calls (typing, reactions). Without a feature
 *   flag it either fires unsupported requests or silently gives up, and the
 *   host cannot tell the difference.
 * - The host UI/CLI needs to render "what can this channel do" without knowing
 *   adapter internals, and must not hardcode a platform list per surface.
 * - Capability claims are testable: `capabilities.test.ts` asserts that every
 *   declared flag has a matching adapter method, so the table cannot drift into
 *   fiction.
 *
 * Adapter implementations stay authoritative at runtime; this table is the
 * shared contract between gateway, host and UI.
 */

import type { PlatformCapability, PlatformType } from './types.js';

/** How inbound messages reach the adapter. */
export type InboundTransport =
  | 'long-poll'
  | 'websocket'
  | 'webhook'
  | 'bridge';

/** One credential/config field a platform needs. */
export interface PlatformCredentialField {
  /** Key inside `PlatformConfig.credentials`. */
  key: string;
  /** Human-readable label for UI/CLI. */
  label: string;
  /** Adapter cannot start without it. */
  required: boolean;
  /** Value must be masked in UI/CLI output. */
  secret?: boolean;
  /** Short hint about where to obtain the value. */
  hint?: string;
}

export interface PlatformDescriptor {
  platform: PlatformType;
  displayName: string;
  /** `experimental` platforms are implemented but not yet end-to-end wired. */
  availability: 'available' | 'experimental';
  inbound: InboundTransport;
  /** Adapter opens a listening socket (needs a free, reachable port). */
  bindsPort: boolean;
  /** Default listening port when `bindsPort` is true. */
  defaultPort?: number;
  /** Default webhook path when `bindsPort` is true. */
  webhookPath?: string;
  credentialFields: PlatformCredentialField[];
  /** Hard platform limit for one message, in UTF-16 code units. */
  maxMessageLength: number;
  capabilities: readonly PlatformCapability[];
}

const TEXT_ONLY_INBOUND: readonly PlatformCapability[] = [
  'text',
  'markdown',
  'inbound-media',
];

export const PLATFORM_DESCRIPTORS: Record<PlatformType, PlatformDescriptor> = {
  telegram: {
    platform: 'telegram',
    displayName: 'Telegram',
    availability: 'available',
    inbound: 'long-poll',
    bindsPort: false,
    credentialFields: [
      { key: 'bot_token', label: 'Bot Token', required: true, secret: true, hint: 'BotFather → /newbot' },
    ],
    maxMessageLength: 4096,
    capabilities: [
      'text',
      'markdown',
      'message-edit',
      'message-delete',
      'typing',
      'reaction',
      'inline-keyboard',
      'inbound-media',
      'outbound-media',
      'voice-note',
      'quoting',
      'threads',
      'group-chat',
      'inbound-callback',
    ],
  },

  feishu: {
    platform: 'feishu',
    displayName: 'Feishu / Lark',
    availability: 'available',
    inbound: 'websocket',
    bindsPort: false,
    credentialFields: [
      { key: 'app_id', label: 'App ID', required: true },
      { key: 'app_secret', label: 'App Secret', required: true, secret: true },
    ],
    maxMessageLength: 30000,
    capabilities: [
      'text',
      'markdown',
      'message-delete',
      'reaction',
      'inbound-media',
      'outbound-media',
      'quoting',
      'group-chat',
      'inbound-callback',
    ],
  },

  weixin: {
    platform: 'weixin',
    displayName: 'WeChat (iLink)',
    availability: 'available',
    inbound: 'long-poll',
    bindsPort: false,
    credentialFields: [
      { key: 'token', label: 'Token', required: true, secret: true },
      { key: 'account_id', label: 'Account ID', required: true },
    ],
    maxMessageLength: 4000,
    capabilities: [
      'text',
      'typing',
      'typing-stop',
      'inbound-media',
      'outbound-media',
      'group-chat',
    ],
  },

  qq: {
    platform: 'qq',
    displayName: 'QQ Bot',
    availability: 'available',
    inbound: 'websocket',
    bindsPort: false,
    credentialFields: [
      { key: 'app_id', label: 'App ID', required: true },
      { key: 'app_secret', label: 'App Secret', required: true, secret: true },
    ],
    maxMessageLength: 4000,
    capabilities: [
      'text',
      'markdown',
      'inbound-media',
      'outbound-media',
      'voice-note',
      'group-chat',
      'inbound-callback',
    ],
  },

  whatsapp: {
    platform: 'whatsapp',
    displayName: 'WhatsApp (Web)',
    availability: 'experimental',
    inbound: 'bridge',
    bindsPort: false,
    credentialFields: [
      { key: 'session_path', label: 'Session Directory', required: false, hint: 'LocalAuth data path' },
    ],
    maxMessageLength: 4096,
    capabilities: [
      'text',
      'markdown',
      'typing',
      'typing-stop',
      'inbound-media',
      'outbound-media',
      'voice-note',
      'quoting',
      'group-chat',
    ],
  },

  discord: {
    platform: 'discord',
    displayName: 'Discord',
    availability: 'available',
    inbound: 'websocket',
    bindsPort: false,
    credentialFields: [
      { key: 'bot_token', label: 'Bot Token', required: true, secret: true, hint: 'Discord Developer Portal → Bot' },
    ],
    maxMessageLength: 2000,
    capabilities: [
      'text',
      'markdown',
      'message-edit',
      'message-delete',
      'typing',
      'reaction',
      'inline-keyboard',
      'inbound-media',
      'outbound-media',
      'quoting',
      'threads',
      'group-chat',
      'inbound-callback',
    ],
  },

  whatsapp_cloud: {
    platform: 'whatsapp_cloud',
    displayName: 'WhatsApp Cloud API',
    availability: 'available',
    inbound: 'webhook',
    bindsPort: true,
    defaultPort: 8090,
    webhookPath: '/whatsapp/webhook',
    credentialFields: [
      { key: 'phone_number_id', label: 'Phone Number ID', required: true, hint: 'Meta App → WhatsApp → API Setup' },
      { key: 'access_token', label: 'Access Token', required: true, secret: true },
      { key: 'app_secret', label: 'App Secret', required: true, secret: true, hint: 'Verifies X-Hub-Signature-256' },
      { key: 'verify_token', label: 'Verify Token', required: true, secret: true, hint: 'Echoed back on webhook subscribe' },
      { key: 'api_version', label: 'API Version', required: false },
    ],
    maxMessageLength: 4096,
    capabilities: [
      'text',
      'markdown',
      'typing',
      'read-receipt',
      'inline-keyboard',
      'interactive-list',
      'inbound-media',
      'outbound-media',
      'voice-note',
      'quoting',
      'inbound-callback',
    ],
  },

  signal: {
    platform: 'signal',
    displayName: 'Signal',
    availability: 'experimental',
    inbound: 'websocket',
    bindsPort: false,
    credentialFields: [
      { key: 'http_url', label: 'signal-cli HTTP URL', required: true, hint: 'e.g. http://127.0.0.1:8080' },
      { key: 'account', label: 'Account (E.164)', required: true, hint: 'e.g. +8613800000000' },
    ],
    maxMessageLength: 8000,
    capabilities: [
      'text',
      'markdown',
      'typing',
      'reaction',
      'inbound-media',
      'outbound-media',
      'quoting',
      'group-chat',
    ],
  },

  bluebubbles: {
    platform: 'bluebubbles',
    displayName: 'iMessage (BlueBubbles)',
    availability: 'experimental',
    inbound: 'webhook',
    bindsPort: true,
    defaultPort: 8645,
    webhookPath: '/bluebubbles-webhook',
    credentialFields: [
      { key: 'server_url', label: 'BlueBubbles Server URL', required: true, hint: 'e.g. http://192.168.1.10:1234' },
      { key: 'password', label: 'Server Password', required: true, secret: true },
    ],
    maxMessageLength: 4000,
    capabilities: [
      'text',
      'typing',
      'read-receipt',
      'inbound-media',
      'outbound-media',
      'voice-note',
      'quoting',
      'group-chat',
    ],
  },

  webhook: {
    platform: 'webhook',
    displayName: 'Inbound Webhook',
    availability: 'available',
    inbound: 'webhook',
    bindsPort: true,
    defaultPort: 8644,
    webhookPath: '/webhooks',
    credentialFields: [
      { key: 'secret', label: 'Signing Secret', required: true, secret: true },
      { key: 'route', label: 'Route Name', required: false },
    ],
    maxMessageLength: 8000,
    capabilities: ['text', 'inbound-callback'],
  },

  msgraph: {
    platform: 'msgraph',
    displayName: 'Microsoft Graph',
    availability: 'experimental',
    inbound: 'webhook',
    bindsPort: true,
    defaultPort: 8646,
    webhookPath: '/msgraph/webhook',
    credentialFields: [
      { key: 'client_state', label: 'Client State', required: true, secret: true, hint: 'Must match the subscription clientState' },
    ],
    maxMessageLength: 4000,
    capabilities: ['text', 'inbound-callback'],
  },
};

/** All platforms, in declaration order. */
export function listPlatforms(): PlatformType[] {
  return Object.keys(PLATFORM_DESCRIPTORS) as PlatformType[];
}

/** Descriptor for one platform (throws on unknown input). */
export function getPlatformDescriptor(platform: PlatformType): PlatformDescriptor {
  const descriptor = PLATFORM_DESCRIPTORS[platform];
  if (!descriptor) throw new Error(`Unknown platform: ${platform}`);
  return descriptor;
}

/** Feature flags declared by a platform. */
export function getPlatformCapabilities(platform: PlatformType): readonly PlatformCapability[] {
  return PLATFORM_DESCRIPTORS[platform]?.capabilities ?? [];
}

/** Whether a platform declares support for one capability. */
export function supportsCapability(platform: PlatformType, capability: PlatformCapability): boolean {
  return getPlatformCapabilities(platform).includes(capability);
}

/** `text` is universal, so every descriptor that declares nothing is a bug. */
export function isKnownPlatform(platform: string): platform is PlatformType {
  return Object.prototype.hasOwnProperty.call(PLATFORM_DESCRIPTORS, platform);
}
