/**
 * TokenService — access-token lifecycle management. Plan 312 Phase 1.
 *
 * Responsibilities:
 *   - Hand out a valid access token for a connection id (called by the
 *     connector service before every provider API call).
 *   - Refresh automatically when the token is within the refresh skew
 *     (5 minutes before expiry).
 *   - Single-flight concurrent refresh: if two callers ask for the same
 *     connection's token while a refresh is in flight, both await the
 *     same promise.
 *   - On `invalid_grant` from the refresh endpoint, flip the connection
 *     to `revoked`, clear the vault entry, and surface
 *     `connection_revoked` to the caller.
 *
 * Tokens NEVER leave the main process via this module — callers receive
 * the access token string only to attach to an outbound HTTP request
 * they themselves issue (still inside the main process).
 */

import { getLogger, LogComponent } from '../../logging/logger';
import { getProviderConfig, getClientSecret } from './providers/registry.js';
import type { ConnectionStore } from './connection-store.js';
import type { TokenVault } from './token-vault.js';
import type {
  AppConnection,
  AppConnectionErrorCode,
  AppConnectionResult,
  TokenSet,
} from './types.js';

const COMPONENT = 'AppConnectionTokenService' as LogComponent;

/** Refresh when within this many ms of expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface TokenServiceDeps {
  store: ConnectionStore;
  vault: TokenVault;
  /** Override fetch in tests. */
  fetchImpl?: typeof fetch;
}

/** Successful token fetch result. */
export interface ValidToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number | null;
  /** True if a refresh was performed to satisfy this request. */
  refreshed: boolean;
}

/** In-flight refresh promises keyed by connectionId — single-flight dedup. */
const inflightRefresh = new Map<string, Promise<ValidToken>>();

export class TokenService {
  private readonly logger = getLogger();
  private readonly store: ConnectionStore;
  private readonly vault: TokenVault;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: TokenServiceDeps) {
    this.store = deps.store;
    this.vault = deps.vault;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /**
   * Get a valid access token for the given connection. Refreshes
   * automatically when within REFRESH_SKEW_MS of expiry.
   *
   * Returns a structured {@link AppConnectionResult} so callers can
   * translate errors uniformly without try/catch parsing.
   */
  async getValidToken(connectionId: string): Promise<AppConnectionResult<ValidToken>> {
    const conn = this.store.get(connectionId);
    if (!conn) {
      return failure('connection_not_found', `connection ${connectionId} not found`, false);
    }
    if (conn.status === 'revoked' || conn.status === 'disconnected') {
      return failure('connection_not_available', `connection is ${conn.status}`, false);
    }

    const tokens = this.vault.get(connectionId);
    if (!tokens) {
      // State drift: metadata says connected but vault is empty. Treat
      // as revoked — needs re-authorization.
      this.store.updateStatus(connectionId, 'revoked', {
        lastError: 'vault entry missing',
      });
      return failure('connection_revoked', 'vault entry missing; re-authorization required', false);
    }

    // No expiry → assume forever valid (some Slack bot tokens don't expire).
    if (tokens.expiresAt === null) {
      return ok({ accessToken: tokens.accessToken, tokenType: tokens.tokenType, expiresAt: null, refreshed: false });
    }

    const now = Date.now();
    if (tokens.expiresAt - now > REFRESH_SKEW_MS) {
      return ok({ accessToken: tokens.accessToken, tokenType: tokens.tokenType, expiresAt: tokens.expiresAt, refreshed: false });
    }

    // Expiring soon — refresh.
    if (!tokens.refreshToken) {
      // No refresh token; surface as expired so caller can prompt re-auth.
      this.store.updateStatus(connectionId, 'expired', {
        lastError: 'access token expired and no refresh_token available',
      });
      return failure('connection_not_available', 'access token expired without a refresh_token', false);
    }

    // Single-flight: if a refresh for this connection is already in
    // flight, await the same promise instead of issuing a second one.
    const existing = inflightRefresh.get(connectionId);
    if (existing) {
      return existing.then(ok, (err) => this.translateRefreshError(err, conn));
    }

    const promise = this.refreshAndStore(conn, tokens.refreshToken).finally(() => {
      inflightRefresh.delete(connectionId);
    });
    inflightRefresh.set(connectionId, promise);

    try {
      return ok(await promise);
    } catch (err) {
      return this.translateRefreshError(err, conn);
    }
  }

  /** Refresh the access token for a connection and persist the new set. */
  private async refreshAndStore(conn: AppConnection, refreshToken: string): Promise<ValidToken> {
    const config = getProviderConfig(conn.provider);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    });
    if (config.requiresClientSecret) {
      const secret = getClientSecret(config.id);
      if (!secret) {
        throw new RefreshError('missing_client_secret', 'client_secret required but not set');
      }
      body.set('client_secret', secret);
    }

    const resp = await this.fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const detail = await parseErrorDetail(resp);
      if (detail.startsWith('invalid_grant')) {
        throw new RefreshError('invalid_grant', detail);
      }
      throw new RefreshError('refresh_failed', detail);
    }

    const data = (await resp.json()) as TokenRefreshResponse;
    if (!data.access_token) {
      throw new RefreshError('refresh_failed', 'refresh response missing access_token');
    }

    const expiresInMs =
      typeof data.expires_in === 'number' && data.expires_in > 0
        ? Date.now() + data.expires_in * 1000
        : null;

    const newTokens: TokenSet = {
      accessToken: data.access_token,
      // RFC 6749 §6: refresh_token MAY be rotated. Persist the new one
      // if returned, otherwise keep the existing one.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: expiresInMs,
      tokenType: data.token_type ?? 'Bearer',
      scopes: conn.scopes,
    };

    this.vault.set(conn.id, newTokens);
    this.store.updateStatus(conn.id, 'connected', {
      expiresAt: expiresInMs,
      lastError: null,
    });

    this.logger.debug(
      'App Connection: token refreshed',
      { connectionId: conn.id, provider: conn.provider },
      COMPONENT,
    );

    return {
      accessToken: newTokens.accessToken,
      tokenType: newTokens.tokenType,
      expiresAt: newTokens.expiresAt,
      refreshed: true,
    };
  }

  /** Convert a refresh error to a structured {@link AppConnectionResult}. */
  private translateRefreshError(err: unknown, conn: AppConnection): AppConnectionResult<ValidToken> {
    if (err instanceof RefreshError) {
      if (err.code === 'invalid_grant') {
        // Refresh permanently failed — user must re-authorize.
        this.vault.remove(conn.id);
        this.store.updateStatus(conn.id, 'revoked', { lastError: 'invalid_grant' });
        this.logger.warn(
          'App Connection: refresh failed (invalid_grant); connection revoked',
          { connectionId: conn.id, provider: conn.provider },
          COMPONENT,
        );
        return failure('connection_revoked', 'refresh failed (invalid_grant); re-authorization required', false);
      }
      return failure('provider_error', err.message, true);
    }
    // Network / unknown.
    return failure(
      'network_error',
      err instanceof Error ? err.message : String(err),
      true,
    );
  }
}

interface TokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/** Internal error type used to carry a structured code out of refresh. */
class RefreshError extends Error {
  constructor(
    public readonly code: 'invalid_grant' | 'refresh_failed' | 'missing_client_secret' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'RefreshError';
  }
}

/** Best-effort error detail from a non-OK response. */
async function parseErrorDetail(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    const parsed = JSON.parse(text) as { error?: string; error_description?: string };
    if (parsed.error) return `${parsed.error}: ${parsed.error_description ?? ''}`;
  } catch {
    // ignore
  }
  return `token endpoint ${resp.status}`;
}

function ok<T>(data: T): AppConnectionResult<T> {
  return { success: true, data };
}

function failure(
  code: AppConnectionErrorCode,
  message: string,
  retriable: boolean,
): AppConnectionResult<never> {
  return { success: false, error: { code, message, retriable } };
}
