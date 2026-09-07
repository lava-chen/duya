/**
 * Connector client registry — Plan 312 Phase 1, opened by Plan 455.
 *
 * Public OAuth client config per connector. Public clients (RFC 8252
 * §6.2) do NOT ship a client secret; we rely on PKCE for security.
 * Slack is the exception that historically requires a secret at the
 * token endpoint — see the plan's Open Question #1; the first cut
 * lets the user supply their own Slack client (setup fields fill
 * clientId/clientSecret).
 *
 * Plan 455 Phase A: the registry is a Map keyed by the branded
 * `AppConnectorId`, not a closed `Record` over a literal union.
 * Plugin-declared connectors (`.app.json`, Plan 455 D3) register
 * themselves here via {@link registerProviderConfig} so the OAuth
 * flows, remote-MCP session setup, and descriptor stamping all treat
 * builtin and declared connectors identically.
 */

import {
  asAppConnectorId,
  type AppConnectorId,
} from '@duya/plugin-core/src/connectors/app-connector-id.js';
import type { ProviderId } from '../types';

/**
 * Google installs can use this public Desktop OAuth client directly. OAuth
 * desktop clients are public by design and use PKCE instead of a client secret.
 */
const DUYA_GOOGLE_DESKTOP_CLIENT_ID =
  '926801753318-8jipblhe5ju1v18stf08u4ltuq1ppn15.apps.googleusercontent.com';

export interface ProviderClientConfig {
  id: ProviderId;
  /** Display label for UI. */
  label: string;
  /** Authorization endpoint (browser opens this). */
  authUrl: string;
  /** Token endpoint (auth code → access token, refresh). */
  tokenUrl: string;
  /** Token revocation endpoint (best-effort on disconnect). */
  revokeUrl?: string;
  /** Loopback redirect path; providers register the full URL in their console. */
  redirectPath: string;
  /** Default scopes; user can extend via manifest declaration. */
  defaultScopes: string[];
  /** When false, the provider connects via manual credentials and needs no
   * OAuth client_id; readiness is always true. Defaults to true (OAuth). */
  requiresOAuthClient?: boolean;
  /** Optional userinfo endpoint for fetching account identity. */
  userinfoUrl?: string;
  /** Whether the provider requires a client_secret at the token endpoint. */
  requiresClientSecret: boolean;
  /** Whether a person may supply their own OAuth client for this provider. */
  supportsManualConfiguration: boolean;
  /** Public client_id (no secret). May be overridden by env or user setup. */
  clientId: string;
  /** Official hosted MCP endpoint. These use RFC 9728 discovery + OAuth DCR. */
  remoteMcpUrl?: string;
  /** Single-letter icon for UI rendering (e.g. 'G' for Google). */
  monogram: string;
  /** One-line summary shown in the marketplace / connection list. */
  description: string;
}

export interface ProviderReadiness {
  configured: boolean;
  reason?: string;
}

/**
 * Built-in client configs. Client IDs ship as a public client and
 * can be overridden per install via the DUYA_APP_CONNECTION_<PROVIDER>_CLIENT_ID
 * env var (read once at first authorization). The bare-string keys are
 * branded at registration time; per-entry `id` fields are stamped in
 * the same loop so no literal ever masquerades as the brand.
 */
const BUILTIN_CONFIGS: Record<string, Omit<ProviderClientConfig, 'id'>> = {
  google: {
    label: 'Google Drive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    redirectPath: '/callback/google',
    defaultScopes: [
      // Google Drive content is read only after the Agent selects a file.
      // Gmail and Calendar need separate, explicit connector consent flows.
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
      'email',
      'profile',
    ],
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    requiresClientSecret: false,
    // Google Drive is a Duya-managed connection. End users should only ever
    // approve access in Google's browser consent page, not create OAuth apps.
    supportsManualConfiguration: false,
    clientId: process.env.DUYA_APP_CONNECTION_GOOGLE_CLIENT_ID ?? DUYA_GOOGLE_DESKTOP_CLIENT_ID,
    monogram: 'G',
    description: 'Search and read files from Google Drive with source links.',
  },
  // Gmail and Calendar are distinct providers (not folded into `google`)
  // so each gets its own OAuth consent page and can be connected or
  // disconnected independently from Google Drive. All three reuse the same
  // public Google desktop OAuth client; the per-provider redirect path is
  // what disambiguates the loopback callback.
  gmail: {
    label: 'Gmail',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    redirectPath: '/callback/gmail',
    defaultScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      // compose covers send + draft lifecycle; modify adds read/label state
      // changes on existing messages (mark read, apply/remove labels).
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'openid',
      'email',
      'profile',
    ],
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    requiresClientSecret: false,
    supportsManualConfiguration: false,
    clientId: process.env.DUYA_APP_CONNECTION_GMAIL_CLIENT_ID ?? DUYA_GOOGLE_DESKTOP_CLIENT_ID,
    monogram: 'G',
    description: 'Read and send email through your connected Gmail account.',
  },
  calendar: {
    label: 'Google Calendar',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    redirectPath: '/callback/calendar',
    defaultScopes: [
      // calendar.events covers read + create on the primary calendar.
      'https://www.googleapis.com/auth/calendar.events',
      'openid',
      'email',
      'profile',
    ],
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    requiresClientSecret: false,
    supportsManualConfiguration: false,
    clientId: process.env.DUYA_APP_CONNECTION_CALENDAR_CLIENT_ID ?? DUYA_GOOGLE_DESKTOP_CLIENT_ID,
    monogram: 'C',
    description: 'Read and create events on your Google Calendar.',
  },
  slack: {
    label: 'Slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: 'https://slack.com/api/auth.revoke',
    redirectPath: '/callback/slack',
    defaultScopes: ['search:read', 'channels:read', 'users:read'],
    userinfoUrl: 'https://slack.com/api/auth.test',
    requiresClientSecret: true,
    supportsManualConfiguration: true,
    clientId: process.env.DUYA_APP_CONNECTION_SLACK_CLIENT_ID ?? '',
    monogram: 'S',
    description: 'Slack workspace messaging and channels',
  },
  microsoft365: {
    label: 'Microsoft 365',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    redirectPath: '/callback/microsoft365',
    defaultScopes: ['Mail.Read', 'Calendars.Read', 'Files.Read.All', 'User.Read'],
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    requiresClientSecret: false,
    supportsManualConfiguration: true,
    clientId: process.env.DUYA_APP_CONNECTION_MICROSOFT365_CLIENT_ID ?? '',
    monogram: 'M',
    description: 'Microsoft 365 (Outlook, OneDrive, Teams)',
  },
  figma: remoteMcpConfig('Figma', 'https://mcp.figma.com/mcp', 'F', 'Figma design files and prototypes'),
  supabase: remoteMcpConfig('Supabase', 'https://mcp.supabase.com/mcp', 'U', 'Supabase backend and database'),
  sentry: remoteMcpConfig('Sentry', 'https://mcp.sentry.dev', 'Y', 'Sentry error monitoring and tracing'),
  vercel: remoteMcpConfig('Vercel', 'https://mcp.vercel.com', 'V', 'Vercel deployments and projects'),
  notion: remoteMcpConfig('Notion', 'https://mcp.notion.com/mcp', 'N', 'Notion pages and databases'),
  linear: remoteMcpConfig('Linear', 'https://mcp.linear.app/mcp', 'L', 'Linear issues and projects'),
  github: remoteMcpConfig('GitHub', 'https://api.githubcopilot.com/mcp', 'G', 'GitHub repositories, pull requests, issues, and CI'),
  // WeCom is a custom-credential provider (corpid/corpsecret), not OAuth. It
  // has no network OAuth endpoints; credentials are stored in the vault and
  // injected into the `wecom-cli` child process by the connector.
  wecom: {
    label: 'WeCom',
    authUrl: '',
    tokenUrl: '',
    redirectPath: '/callback/wecom',
    defaultScopes: [],
    requiresClientSecret: false,
    supportsManualConfiguration: true,
    requiresOAuthClient: false,
    clientId: '',
    monogram: 'W',
    description: 'WeCom (WeChat Work) enterprise messaging, docs, contacts, meetings, schedules, todos',
  },
  // QQ Mail is a custom-credential provider (email + 16-digit authorization
  // code), not OAuth. It has no public OAuth2 for third parties; the connector
  // uses IMAP (read) and SMTP (send). Credentials live in the vault's
  // OAuth-client slot (clientId = email, clientSecret = auth code).
  'qq-mail': {
    label: 'QQ 邮箱',
    authUrl: '',
    tokenUrl: '',
    redirectPath: '/callback/qq-mail',
    defaultScopes: [],
    requiresClientSecret: false,
    supportsManualConfiguration: true,
    requiresOAuthClient: false,
    clientId: '',
    monogram: 'Q',
    description: 'QQ Mail (mail.qq.com) read, search, and send via IMAP/SMTP with an authorization code',
  },
};

function remoteMcpConfig(
  label: string,
  remoteMcpUrl: string,
  monogram: string,
  description: string,
): Omit<ProviderClientConfig, 'id'> {
  return {
    label,
    // The MCP SDK discovers the authorization server from the protected
    // resource. These fields are deliberately unused for remote MCP OAuth.
    authUrl: '',
    tokenUrl: '',
    redirectPath: '',
    defaultScopes: [],
    requiresClientSecret: false,
    supportsManualConfiguration: false,
    clientId: '',
    remoteMcpUrl,
    monogram,
    description,
  };
}

/** Open registry — Plan 455. Declared connectors register at runtime. */
const REGISTRY = new Map<AppConnectorId, ProviderClientConfig>(
  Object.entries(BUILTIN_CONFIGS).map(([key, config]) => [
    asAppConnectorId(key),
    { ...config, id: asAppConnectorId(key) },
  ]),
);

// remoteMCP configs used a per-id redirect path; stamp it from the key now.
for (const [id, config] of REGISTRY) {
  if (!config.redirectPath && config.remoteMcpUrl) {
    config.redirectPath = `/callback/mcp/${id}`;
  }
}

/**
 * Register a plugin-declared connector (`.app.json` → config projection,
 * Plan 455 Phase C). Overwrites nothing: an existing id (builtin or
 * previously registered) rejects the registration — callers surface the
 * reason as a plugin-load warning.
 */
export function registerProviderConfig(config: ProviderClientConfig): { ok: boolean; reason?: string } {
  if (REGISTRY.has(config.id)) {
    return { ok: false, reason: `connector ${config.id} is already registered` };
  }
  REGISTRY.set(config.id, config);
  return { ok: true };
}

export function unregisterProviderConfig(id: AppConnectorId): boolean {
  return REGISTRY.delete(id);
}

export function getProviderConfig(provider: ProviderId): ProviderClientConfig | undefined {
  return REGISTRY.get(provider);
}

/**
 * A connector must fail closed when the build has no OAuth client. Placeholder
 * ids made the UI appear connectable but sent users into an authorization flow
 * that every provider rejected. Client ids are public; client secrets remain
 * main-process-only and never appear in this result.
 */
export function getProviderReadiness(provider: ProviderId): ProviderReadiness {
  const config = getProviderConfig(provider);
  if (!config) {
    return { configured: false, reason: `Connector ${provider} is not registered in this build` };
  }
  if (config.remoteMcpUrl) {
    return { configured: true };
  }
  // Custom-credential providers (e.g. WeCom) never need an OAuth client;
  // they are always connectable via manual credentials.
  if (config.requiresOAuthClient === false) {
    return { configured: true };
  }
  if (!config.clientId.trim()) {
    return {
      configured: false,
      reason: `OAuth client ID for ${provider} is not configured in this build`,
    };
  }
  if (config.requiresClientSecret && !getClientSecret(provider)) {
    return {
      configured: false,
      reason: `OAuth client secret for ${provider} is not configured`,
    };
  }
  return { configured: true };
}

export function listProviders(): ProviderClientConfig[] {
  return Array.from(REGISTRY.values());
}

/**
 * Type-guard narrow for IPC payloads: validates against the live
 * (possibly extended) registry and narrows to the branded id.
 */
export function isKnownProvider(provider: string): provider is AppConnectorId {
  return REGISTRY.has(asAppConnectorId(provider));
}

/**
 * Override a client_id at runtime — used when a plugin's setup field
 * supplies its own OAuth client (e.g. user-registered Slack app).
 * Caller is responsible for persisting the override; the registry
 * holds it in-memory for the lifetime of the process.
 */
export function overrideClientId(provider: ProviderId, clientId: string): void {
  const config = REGISTRY.get(provider);
  if (!config) return;
  REGISTRY.set(provider, { ...config, clientId });
}

/**
 * Override client_secret at runtime. Only meaningful for providers
 * with `requiresClientSecret === true`. Held in memory only — the
 * secret NEVER touches disk via this layer.
 */
const clientSecrets = new Map<AppConnectorId, string>();
export function setClientSecret(provider: ProviderId, secret: string): void {
  clientSecrets.set(provider, secret);
}

export function clearClientSecret(provider: ProviderId): void {
  clientSecrets.delete(provider);
}
export function getClientSecret(provider: ProviderId): string | undefined {
  return (
    clientSecrets.get(provider) ??
    process.env[`DUYA_APP_CONNECTION_${provider.toUpperCase()}_CLIENT_SECRET`]
  );
}
