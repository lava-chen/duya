/**
 * Provider client registry — Plan 312 Phase 1.
 *
 * Public OAuth client config per provider. Public clients (RFC 8252
 * §6.2) do NOT ship a client secret; we rely on PKCE for security.
 * Slack is the exception that historically requires a secret at the
 * token endpoint — see the plan's Open Question #1; the first cut
 * lets the user supply their own Slack client (setup fields fill
 * clientId/clientSecret).
 */

import type { ProviderId } from '../types';

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
  /** Optional userinfo endpoint for fetching account identity. */
  userinfoUrl?: string;
  /** Whether the provider requires a client_secret at the token endpoint. */
  requiresClientSecret: boolean;
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
 * Built-in client registry. Client IDs ship as a public client and
 * can be overridden per install via the DUYA_APP_CONNECTION_<PROVIDER>_CLIENT_ID
 * env var (read once at first authorization).
 */
const REGISTRY: Record<ProviderId, ProviderClientConfig> = {
  google: {
    id: 'google',
    label: 'Google Workspace',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    redirectPath: '/callback/google',
    defaultScopes: [
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'openid',
      'email',
      'profile',
    ],
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    requiresClientSecret: false,
    clientId: process.env.DUYA_APP_CONNECTION_GOOGLE_CLIENT_ID ?? '',
    monogram: 'G',
    description: 'Google Workspace (Gmail, Calendar, Drive, Docs)',
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: 'https://slack.com/api/auth.revoke',
    redirectPath: '/callback/slack',
    defaultScopes: ['search:read', 'channels:read', 'users:read'],
    userinfoUrl: 'https://slack.com/api/auth.test',
    requiresClientSecret: true,
    clientId: process.env.DUYA_APP_CONNECTION_SLACK_CLIENT_ID ?? '',
    monogram: 'S',
    description: 'Slack workspace messaging and channels',
  },
  microsoft365: {
    id: 'microsoft365',
    label: 'Microsoft 365',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    redirectPath: '/callback/microsoft365',
    defaultScopes: ['Mail.Read', 'Calendars.Read', 'Files.Read.All', 'User.Read'],
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    requiresClientSecret: false,
    clientId: process.env.DUYA_APP_CONNECTION_MICROSOFT365_CLIENT_ID ?? '',
    monogram: 'M',
    description: 'Microsoft 365 (Outlook, OneDrive, Teams)',
  },
  figma: remoteMcpProvider('figma', 'Figma', 'https://mcp.figma.com/mcp', 'F', 'Figma design files and prototypes'),
  supabase: remoteMcpProvider('supabase', 'Supabase', 'https://mcp.supabase.com/mcp', 'U', 'Supabase backend and database'),
  sentry: remoteMcpProvider('sentry', 'Sentry', 'https://mcp.sentry.dev', 'Y', 'Sentry error monitoring and tracing'),
  vercel: remoteMcpProvider('vercel', 'Vercel', 'https://mcp.vercel.com', 'V', 'Vercel deployments and projects'),
  notion: remoteMcpProvider('notion', 'Notion', 'https://mcp.notion.com/mcp', 'N', 'Notion pages and databases'),
  linear: remoteMcpProvider('linear', 'Linear', 'https://mcp.linear.app/mcp', 'L', 'Linear issues and projects'),
};

function remoteMcpProvider(
  id: ProviderId,
  label: string,
  remoteMcpUrl: string,
  monogram: string,
  description: string,
): ProviderClientConfig {
  return {
    id,
    label,
    // The MCP SDK discovers the authorization server from the protected
    // resource. These fields are deliberately unused for remote MCP OAuth.
    authUrl: '',
    tokenUrl: '',
    redirectPath: `/callback/mcp/${id}`,
    defaultScopes: [],
    requiresClientSecret: false,
    clientId: '',
    remoteMcpUrl,
    monogram,
    description,
  };
}

export function getProviderConfig(provider: ProviderId): ProviderClientConfig {
  return REGISTRY[provider];
}

/**
 * A connector must fail closed when the build has no OAuth client. Placeholder
 * ids made the UI appear connectable but sent users into an authorization flow
 * that every provider rejected. Client ids are public; client secrets remain
 * main-process-only and never appear in this result.
 */
export function getProviderReadiness(provider: ProviderId): ProviderReadiness {
  const config = getProviderConfig(provider);
  if (config.remoteMcpUrl) {
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
  return Object.values(REGISTRY);
}

export function isKnownProvider(provider: string): provider is ProviderId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, provider);
}

/**
 * Override a client_id at runtime — used when a plugin's setup field
 * supplies its own OAuth client (e.g. user-registered Slack app).
 * Caller is responsible for persisting the override; the registry
 * holds it in-memory for the lifetime of the process.
 */
export function overrideClientId(provider: ProviderId, clientId: string): void {
  REGISTRY[provider] = { ...REGISTRY[provider], clientId };
}

/**
 * Override client_secret at runtime. Only meaningful for providers
 * with `requiresClientSecret === true`. Held in memory only — the
 * secret NEVER touches disk via this layer.
 */
const clientSecrets = new Map<ProviderId, string>();
export function setClientSecret(provider: ProviderId, secret: string): void {
  clientSecrets.set(provider, secret);
}

export function clearClientSecret(provider: ProviderId): void {
  clientSecrets.delete(provider);
}
export function getClientSecret(provider: ProviderId): string | undefined {
  return clientSecrets.get(provider) ?? process.env[`DUYA_APP_CONNECTION_${provider.toUpperCase()}_CLIENT_SECRET`];
}
