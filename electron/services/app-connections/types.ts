/**
 * App Connection — shared types.
 *
 * Plan 312: Duya-managed OAuth authorization-code flow + safeStorage
 * token vault + connection state model. Tokens NEVER leave the main
 * process; only status DTOs cross the IPC boundary.
 */

/** Provider identifiers supported by the first release. */
export type ProviderId = 'google' | 'slack' | 'microsoft365';

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

/**
 * Encrypted token set persisted in the vault. The vault file itself
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

/** Structured error code used by connector invocations. */
export type AppConnectionErrorCode =
  | 'vault_unavailable'
  | 'connection_not_found'
  | 'connection_not_available'
  | 'connection_revoked'
  | 'provider_error'
  | 'invalid_grant'
  | 'network_error'
  | 'unknown_action'
  | 'internal'
  | 'provider_blocked';

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
