/**
 * OAuth authorization-code flow orchestrator — Plan 312 Phase 1.
 *
 * Glues the loopback redirect server, PKCE challenge, provider client
 * config, token exchange, and account-identity fetch into a single
 * `startAuthorization(providerId, scopes)` entry point.
 *
 * The flow is one-shot: a fresh loopback server + state nonce is
 * created per attempt and torn down as soon as the callback lands
 * (or the timeout fires). The verifier/state never persist beyond
 * the call.
 *
 * Tokens are written to the vault, connection metadata to the
 * ConnectionStore. The renderer never sees a token — only the
 * returned status DTO.
 */

import { shell } from 'electron';
import { randomUUID } from 'crypto';
import { getLogger, LogComponent } from '../../../logging/logger';
import { buildPkceChallenge } from './pkce.js';
import { startLoopbackServer, LoopbackServerError } from './loopback-server.js';
import { getProviderConfig, getClientSecret, getProviderReadiness } from '../providers/registry.js';
import { fetchGoogleAccountIdentity } from '../providers/google.js';
import { fetchSlackAccountIdentity } from '../providers/slack.js';
import { fetchMicrosoft365AccountIdentity } from '../providers/microsoft365.js';
import { VaultUnavailableError } from '../token-vault.js';
import type {
  AppConnection,
  AppConnectionStatusDTO,
  ProviderId,
  TokenSet,
} from '../types.js';
import { toStatusDTO } from '../types.js';

const COMPONENT = 'AppConnectionFlow' as LogComponent;

/** Loopback redirect wait timeout (3 min, matches loopback-server default). */
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

export interface StartAuthorizationOptions {
  /** Override the default scopes from the provider registry. */
  scopes?: string[];
  /** Hard timeout for the entire redirect wait, in ms. */
  timeoutMs?: number;
  /**
   * Custom fetch implementation (tests). Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * Custom external-url opener (tests). Defaults to shell.openExternal.
   */
  openExternal?: (url: string) => Promise<void>;
  /**
   * Pre-allocated connection id. Generated when omitted.
   */
  connectionId?: string;
}

export interface AuthorizationCallbacks {
  /**
   * Persist a connection record. The orchestrator fills in
   * `status='connected'`, account identity, scopes, and expiry.
   */
  upsertConnection: (conn: AppConnection) => AppConnection;
  /** Store the token set in the encrypted vault. */
  storeTokens: (connectionId: string, tokens: TokenSet) => void;
}

/** Identity fetcher per provider — the only provider-specific hook. */
type IdentityFetcher = (
  accessToken: string,
  fetchImpl: typeof fetch,
) => Promise<{ accountId: string; accountLabel: string }>;

const IDENTITY_FETCHERS: Partial<Record<ProviderId, IdentityFetcher>> = {
  google: fetchGoogleAccountIdentity,
  slack: fetchSlackAccountIdentity,
  microsoft365: fetchMicrosoft365AccountIdentity,
};

/** Response envelope for the token endpoint. */
interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Run the full authorization-code + PKCE flow for a single provider.
 *
 * Steps:
 *   1. Build PKCE + state nonce.
 *   2. Start loopback server; record the bound redirect URI.
 *   3. Open the provider auth URL in the system browser.
 *   4. Wait for the redirect callback (or timeout).
 *   5. Exchange the auth code for tokens at the provider token endpoint.
 *   6. Fetch account identity via the provider's userinfo endpoint.
 *   7. Persist connection metadata + encrypted tokens.
 *   8. Return the renderer-safe status DTO.
 *
 * On any failure the connection is left in the `error` state (or not
 * created at all if the failure happens before the first upsert).
 */
export async function startAuthorization(
  provider: ProviderId,
  callbacks: AuthorizationCallbacks,
  options: StartAuthorizationOptions = {},
): Promise<AppConnectionStatusDTO> {
  const logger = getLogger();
  const config = getProviderConfig(provider);
  const readiness = getProviderReadiness(provider);
  if (!readiness.configured) {
    throw new FlowError('provider_not_configured', readiness.reason ?? `Provider ${provider} is not configured`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const openExternal = options.openExternal ?? shell.openExternal;
  const scopes = options.scopes ?? config.defaultScopes;
  const connectionId = options.connectionId ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1) PKCE + state
  const pkce = buildPkceChallenge();

  // 2) Loopback server
  const loopback = await startLoopbackServer({
    path: config.redirectPath,
    expectedState: pkce.state,
    timeoutMs,
  });

  // 3) Build the authorization URL and open it in the system browser.
  const authUrl = buildAuthUrl(config, {
    redirectUri: loopback.redirectUri,
    state: pkce.state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    scopes,
  });

  logger.info(
    'App Connection: opening authorization URL',
    { provider, connectionId },
    COMPONENT,
  );
  try {
    await openExternal(authUrl);
  } catch (err) {
    loopback.close();
    throw new FlowError(
      'open_external_failed',
      `Failed to open system browser: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4) Wait for the redirect. This rejects on timeout / state mismatch.
  let code: string;
  try {
    const result = await loopback.waitForCode();
    code = result.code;
  } catch (err) {
    throw err instanceof LoopbackServerError
      ? new FlowError('redirect_failed', err.message)
      : err;
  } finally {
    loopback.close();
  }

  // 5) Exchange code → tokens
  let tokens: TokenSet;
  try {
    tokens = await exchangeCodeForTokens(config, {
      code,
      redirectUri: loopback.redirectUri,
      codeVerifier: pkce.codeVerifier,
      fetchImpl,
    });
  } catch (err) {
    throw err instanceof FlowError
      ? err
      : new FlowError(
          'token_exchange_failed',
          err instanceof Error ? err.message : String(err),
        );
  }

  // 6) Fetch account identity (best-effort label; failure is recoverable).
  let accountId = '';
  let accountLabel = '';
  try {
    const fetchIdentity = IDENTITY_FETCHERS[provider];
    if (fetchIdentity) {
      const identity = await fetchIdentity(tokens.accessToken, fetchImpl);
      accountId = identity.accountId;
      accountLabel = identity.accountLabel;
    } else {
      accountLabel = provider;
    }
  } catch (err) {
    logger.warn(
      'App Connection: account identity fetch failed; using placeholder',
      err instanceof Error ? err : new Error(String(err)),
      COMPONENT,
    );
    accountLabel = provider;
  }

  // 7) Persist metadata + tokens
  const now = Date.now();
  const conn: AppConnection = {
    id: connectionId,
    provider,
    accountLabel,
    accountId,
    scopes,
    status: 'connected',
    expiresAt: tokens.expiresAt,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    callbacks.storeTokens(connectionId, tokens);
  } catch (err) {
    if (err instanceof VaultUnavailableError) {
      throw new FlowError(
        'vault_unavailable',
        'safeStorage encryption unavailable; refusing to persist plaintext tokens',
      );
    }
    throw err;
  }
  const persisted = callbacks.upsertConnection(conn);

  logger.info(
    'App Connection: authorization complete',
    { provider, connectionId, accountLabel },
    COMPONENT,
  );

  return toStatusDTO(persisted);
}

/** Build the provider authorization URL with PKCE + state. */
function buildAuthUrl(
  config: ReturnType<typeof getProviderConfig>,
  params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
    scopes: string[];
  },
): string {
  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', params.codeChallengeMethod);
  if (params.scopes.length > 0) {
    // Google/Microsoft accept space-delimited; Slack accepts comma. Space
    // is the OAuth 2.0 default (RFC 6749 §3.3) and Slack tolerates it.
    url.searchParams.set('scope', params.scopes.join(' '));
  }
  return url.toString();
}

/** Exchange the authorization code for tokens at the provider token endpoint. */
async function exchangeCodeForTokens(
  config: ReturnType<typeof getProviderConfig>,
  params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    fetchImpl: typeof fetch;
  },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: config.clientId,
    code_verifier: params.codeVerifier,
  });

  if (config.requiresClientSecret) {
    const secret = getClientSecret(config.id);
    if (!secret) {
      throw new FlowError(
        'missing_client_secret',
        `Provider ${config.id} requires a client_secret that was not supplied`,
      );
    }
    body.set('client_secret', secret);
  }

  const resp = await params.fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  // Slack returns 200 with `{ok:false,error}`; others use 4xx.
  if (!resp.ok) {
    let detail = `token endpoint ${resp.status}`;
    try {
      const text = await resp.text();
      // Only surface the error code field, never the raw body.
      const parsed = JSON.parse(text) as TokenEndpointResponse;
      if (parsed.error) detail = `${parsed.error}: ${parsed.error_description ?? ''}`;
    } catch {
      // ignore parse failure
    }
    if (detail.startsWith('invalid_grant')) {
      throw new FlowError('invalid_grant', detail);
    }
    throw new FlowError('token_exchange_failed', detail);
  }

  const data = (await resp.json()) as TokenEndpointResponse;
  if (!data.access_token) {
    if (data.error) {
      throw new FlowError('token_exchange_failed', `${data.error}: ${data.error_description ?? ''}`);
    }
    throw new FlowError('token_exchange_failed', 'token endpoint returned no access_token');
  }

  const expiresInMs =
    typeof data.expires_in === 'number' && data.expires_in > 0
      ? Date.now() + data.expires_in * 1000
      : null;

  // Slack's scope echo is comma-separated; normalize to spaces.
  const scopeStr = typeof data.scope === 'string' ? data.scope : '';
  const returnedScopes = scopeStr
    ? scopeStr.split(/[\s,]+/).filter(Boolean)
    : [];

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: expiresInMs,
    tokenType: data.token_type ?? 'Bearer',
    scopes: returnedScopes,
  };
}

/** Structured error from the flow. Maps to AppConnectionErrorCode. */
export class FlowError extends Error {
  constructor(
    public readonly code:
      | 'open_external_failed'
      | 'redirect_failed'
      | 'token_exchange_failed'
      | 'invalid_grant'
      | 'missing_client_secret'
      | 'vault_unavailable'
      | 'provider_blocked'
      | 'provider_not_configured',
    message: string,
  ) {
    super(message);
    this.name = 'FlowError';
  }
}
