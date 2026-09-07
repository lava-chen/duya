/**
 * App Connection — shared types.
 *
 * Plan 312: Duya-managed OAuth authorization-code flow + safeStorage
 * token vault + connection state model. Tokens NEVER leave the main
 * process; only status DTOs cross the IPC boundary.
 */

/**
 * Plan 455 Phase A: the connector catalog is OPEN — `AppConnectorId` is a
 * branded string, not a closed union. New connectors are declared by
 * plugin `.app.json` files (Plan 455 D3) and resolved at runtime; the
 * builtin ids below are well-known residents, not the type's extent.
 * Codex parity: `codex-rs/plugin/src/lib.rs` `AppConnectorId(pub String)`.
 */
export type {
  AppConnectorId,
} from '@duya/plugin-core/src/connectors/app-connector-id.js';
export {
  asAppConnectorId,
  BUILTIN_CONNECTOR_IDS,
  isBuiltinConnectorId,
  isWellFormedConnectorId,
  pluginConnectorId,
} from '@duya/plugin-core/src/connectors/app-connector-id.js';

/** Legacy alias for pre-455 consumers. */
export type ProviderId = import('@duya/plugin-core/src/connectors/app-connector-id.js').AppConnectorId;

/**
 * Connection lifecycle states.
 *
 * - `disconnected` — no token, never authorized or user revoked
 * - `pending`      — authorization flow in progress (loopback server up)
 * - `connected`    — valid token in vault, ready to call provider
 * - `expired`      — token expired, refresh available
 * - `revoked`      — refresh failed (invalid_grant), needs re-authorization
 * - `error`        — transient failure (network, provider 5xx, etc.)
 */
export type AppConnectionStatus =
  | 'disconnected'
  | 'pending'
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'error';

/** Persisted connection record (metadata only; tokens live in the vault). */
export interface AppConnection {
  id: string;
  provider: ProviderId;
  /** Human-readable account label (e.g. "alice@example.com"). */
  accountLabel: string;
  /** Provider-issued account identifier (e.g. sub, user_id, openid sub). */
  accountId: string;
  scopes: string[];
  status: AppConnectionStatus;
  /** Token expiry epoch ms; null if unknown or no expiry. */
  expiresAt: number | null;
  /** Last error message when status === 'error' | 'revoked'. */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Renderer-safe projection of {@link AppConnection}. Tokens NEVER appear
 * here. This is the only shape returned from `appConnection:*` IPC.
 */
export interface AppConnectionStatusDTO {
  id: string;
  provider: ProviderId;
  accountLabel: string;
  accountId: string;
  scopes: string[];
  status: AppConnectionStatus;
  expiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Renderer-safe OAuth provider state for the preset connection catalog. */
export interface AppConnectionProviderDTO {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** Non-secret reason shown when a build has no registered OAuth client. */
  configurationHint?: string;
  /** Whether this provider intentionally supports a self-hosted OAuth client. */
  supportsManualConfiguration: boolean;
  /** Whether the token endpoint requires a client_secret (drives the secret
   * input visibility in the manual-config dialog). */
  requiresClientSecret: boolean;
  /** Single-letter icon for UI rendering (e.g. 'G' for Google). */
  monogram: string;
  /** One-line summary shown in the marketplace / connection list. */
  description: string;
  /** Default scopes; used by the marketplace to preview access. */
  scopes?: string[];
}

/** Whitelist mapper: never leaks token fields by accident. */
export function toStatusDTO(conn: AppConnection): AppConnectionStatusDTO {
  return {
    id: conn.id,
    provider: conn.provider,
    accountLabel: conn.accountLabel,
    accountId: conn.accountId,
    scopes: conn.scopes,
    status: conn.status,
    expiresAt: conn.expiresAt,
    lastError: conn.lastError,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

/** Encrypted token set persisted in the vault. The vault file itself
 * is safeStorage-encrypted, but we treat the in-memory shape as a
 * secret too — it is never sent to the renderer or agent process.
 */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number | null;
  tokenType: string;
  scopes: string[];
}

/**
 * Manual credentials for a custom-credential provider such as WeCom.
 * Unlike OAuth tokens, these are per-provider application credentials
 * (e.g. enterprise `corpid` + `corpsecret`) stored in the vault's
 * OAuth-client slot and injected into an external CLI at invocation time.
 */
export interface ManualProviderCredentials {
  /** Enterprise id (corpid) for WeCom. */
  clientId: string;
  /** Enterprise secret (corpsecret) for WeCom. */
  clientSecret: string;
}

/** Structured error code used by connector invocations. */
export type AppConnectionErrorCode =
  | 'vault_unavailable'
  | 'connection_not_found'
  | 'connection_not_available'
  | 'connection_revoked'
  /** Plan 450: user-actionable auth failure mid-call. Signals the renderer
   *  to surface a re-authorization card rather than a dead-end error. */
  | 'connector_auth_required'
  | 'provider_error'
  | 'invalid_grant'
  | 'network_error'
  | 'unknown_action'
  | 'internal'
  | 'provider_blocked'
  | 'provider_not_configured';

/** Structured connector error returned to the agent executor. */
export interface AppConnectionError {
  code: AppConnectionErrorCode;
  message: string;
  /** True if a retry might succeed (e.g. transient network). */
  retriable: boolean;
}

/** Result envelope for connector invocations. */
export type AppConnectionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: AppConnectionError };

/** Risk tier for a connector tool (design doc §6). */
export type RiskTier = 'read' | 'draft' | 'write' | 'modify' | 'destructive';
