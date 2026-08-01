/**
 * Remote MCP OAuth flow.
 *
 * Hosted MCP servers advertise protected-resource metadata and an OAuth
 * authorization server. The MCP SDK performs that discovery and dynamic
 * client registration; Duya supplies a native-app loopback callback and an
 * encrypted persistence adapter. Tokens and client-registration state never
 * cross the Electron main-process boundary.
 */

import { randomUUID } from 'crypto';
import { shell } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { getLogger, LogComponent } from '../../../logging/logger';
import { startLoopbackServer } from './loopback-server.js';
import type { ConnectionStore } from '../connection-store.js';
import type { TokenVault } from '../token-vault.js';
import { VaultUnavailableError } from '../token-vault.js';
import type { AppConnection, AppConnectionStatusDTO, ProviderId, TokenSet } from '../types.js';
import { toStatusDTO } from '../types.js';
import { getProviderConfig } from '../providers/registry.js';
import { FlowError } from './flow.js';

const COMPONENT = 'RemoteMcpOAuth' as LogComponent;

export interface RemoteMcpAuthorizationDeps {
  store: ConnectionStore;
  vault: TokenVault;
  openExternal?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export class VaultOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    private readonly vault: TokenVault,
    private readonly connectionId: string,
    private readonly redirectUri: string,
    private readonly csrfState: string,
    private readonly openExternal: (url: string) => Promise<void>,
  ) {
    this.clientMetadata = {
      client_name: 'Duya Desktop',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  state(): string {
    return this.csrfState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.vault.getMcpOAuth(this.connectionId)?.clientInformation as OAuthClientInformationMixed | undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.vault.setMcpOAuth(this.connectionId, {
      ...this.vault.getMcpOAuth(this.connectionId),
      clientInformation: clientInformation as unknown as Record<string, unknown>,
    });
  }

  tokens(): OAuthTokens | undefined {
    const tokens = this.vault.get(this.connectionId);
    if (!tokens) return undefined;
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: tokens.tokenType,
      ...(tokens.expiresAt ? { expires_in: Math.max(0, Math.floor((tokens.expiresAt - Date.now()) / 1000)) } : {}),
      ...(tokens.scopes.length ? { scope: tokens.scopes.join(' ') } : {}),
    };
  }

  saveTokens(tokens: OAuthTokens): void {
    const previous = this.vault.get(this.connectionId);
    const mapped: TokenSet = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous?.refreshToken,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      tokenType: tokens.token_type,
      scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? previous?.scopes ?? [],
    };
    this.vault.set(this.connectionId, mapped);
  }

  redirectToAuthorization(url: URL): Promise<void> {
    return this.openExternal(url.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.vault.setMcpOAuth(this.connectionId, {
      ...this.vault.getMcpOAuth(this.connectionId),
      codeVerifier,
    });
  }

  codeVerifier(): string {
    const verifier = this.vault.getMcpOAuth(this.connectionId)?.codeVerifier;
    if (!verifier) throw new Error('Remote MCP OAuth PKCE verifier is unavailable');
    return verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.vault.getMcpOAuth(this.connectionId)?.discovery as OAuthDiscoveryState | undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.vault.setMcpOAuth(this.connectionId, {
      ...this.vault.getMcpOAuth(this.connectionId),
      discovery: state as unknown as Record<string, unknown>,
    });
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const previous = this.vault.getMcpOAuth(this.connectionId) ?? {};
    if (scope === 'all' || scope === 'tokens') this.vault.remove(this.connectionId);
    if (scope === 'all') {
      this.vault.removeMcpOAuth(this.connectionId);
      return;
    }
    this.vault.setMcpOAuth(this.connectionId, {
      clientInformation: scope === 'client' ? undefined : previous.clientInformation,
      codeVerifier: scope === 'verifier' ? undefined : previous.codeVerifier,
      discovery: scope === 'discovery' ? undefined : previous.discovery,
      redirectUri: previous.redirectUri,
    });
  }
}

/**
 * Reconstruct a provider for a previously connected Remote MCP. It may refresh
 * silently, but an expired/revoked grant deliberately fails closed and asks the
 * user to press Connect again instead of opening a browser during a tool call.
 */
export function createStoredRemoteMcpOAuthProvider(
  vault: TokenVault,
  connectionId: string,
): OAuthClientProvider {
  const redirectUri = vault.getMcpOAuth(connectionId)?.redirectUri;
  if (!redirectUri) throw new Error('Remote MCP OAuth redirect metadata is unavailable; reconnect the app');
  return new VaultOAuthProvider(
    vault,
    connectionId,
    redirectUri,
    randomUUID(),
    async () => {
      throw new Error('Remote MCP authorization needs user interaction; reconnect the app');
    },
  );
}

/**
 * Verify that a freshly authorized Remote MCP connection can be established.
 *
 * The MCP SDK's StreamableHTTPClientTransport can only be started once; after
 * the initial OAuth redirect flow finishes we construct a brand-new transport
 * and client so the validation handshake starts from a clean state.
 */
async function verifyRemoteMcpConnection(
  remoteMcpUrl: string,
  vault: TokenVault,
  connectionId: string,
): Promise<void> {
  const authProvider = createStoredRemoteMcpOAuthProvider(vault, connectionId);
  const transport = new StreamableHTTPClientTransport(new URL(remoteMcpUrl), { authProvider });
  const client = new Client({ name: 'duya-desktop', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

/** Build a human-readable account label from the OAuth scopes when no userinfo is available. */
function buildAccountLabel(providerLabel: string, scopes: string[]): string {
  if (scopes.length === 0) return providerLabel;
  return `${providerLabel} · ${scopes.length} scope${scopes.length === 1 ? '' : 's'}`;
}

/** Run the interactive RFC 9728 + OAuth 2.1 flow for an official Remote MCP. */
export async function startRemoteMcpAuthorization(
  provider: ProviderId,
  deps: RemoteMcpAuthorizationDeps,
): Promise<AppConnectionStatusDTO> {
  const config = getProviderConfig(provider);
  if (!config.remoteMcpUrl) {
    throw new FlowError('provider_not_configured', `${provider} is not a Remote MCP provider`);
  }

  const logger = getLogger();
  const connectionId = randomUUID();
  const csrfState = randomUUID();
  const openExternal = deps.openExternal ?? shell.openExternal;
  const loopback = await startLoopbackServer({
    path: config.redirectPath,
    expectedState: csrfState,
    timeoutMs: deps.timeoutMs,
    host: 'localhost',
  });
  const authProvider = new VaultOAuthProvider(
    deps.vault,
    connectionId,
    loopback.redirectUri,
    csrfState,
    openExternal,
  );
  deps.vault.setMcpOAuth(connectionId, {
    ...deps.vault.getMcpOAuth(connectionId),
    redirectUri: loopback.redirectUri,
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.remoteMcpUrl), { authProvider });
  const client = new Client({ name: 'duya-desktop', version: '0.1.0' }, { capabilities: {} });

  try {
    try {
      await client.connect(transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      logger.info('Remote MCP OAuth: waiting for loopback callback', { provider, connectionId }, COMPONENT);
      const callback = await loopback.waitForCode();
      logger.info('Remote MCP OAuth: callback received, exchanging code', { provider, connectionId }, COMPONENT);
      await transport.finishAuth(callback.code);

      const tokensAfterExchange = deps.vault.get(connectionId);
      if (!tokensAfterExchange) {
        throw new FlowError('token_exchange_failed', 'Remote MCP OAuth token exchange did not persist a token');
      }
    }

    // Validate the authenticated session with a fresh transport/client pair.
    // Reusing the initial transport would fail because it has already been
    // started by the first connect() attempt.
    logger.info('Remote MCP OAuth: verifying authenticated session', { provider, connectionId }, COMPONENT);
    await verifyRemoteMcpConnection(config.remoteMcpUrl, deps.vault, connectionId);

    const tokens = deps.vault.get(connectionId);
    if (!tokens) {
      throw new FlowError('token_exchange_failed', 'Remote MCP OAuth completed without a token');
    }
    const now = Date.now();
    const connection: AppConnection = {
      id: connectionId,
      provider,
      accountLabel: buildAccountLabel(config.label, tokens.scopes),
      accountId: '',
      scopes: tokens.scopes,
      status: 'connected',
      expiresAt: tokens.expiresAt,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    const persisted = deps.store.upsert(connection);
    logger.info('Remote MCP OAuth: connection established', { provider, connectionId }, COMPONENT);
    return toStatusDTO(persisted);
  } catch (error) {
    logger.warn(
      'Remote MCP authorization failed',
      error instanceof Error ? error : new Error(String(error)),
      { provider, connectionId },
      COMPONENT,
    );
    if (error instanceof VaultUnavailableError) {
      throw new FlowError('vault_unavailable', 'safeStorage encryption unavailable; refusing to persist plaintext tokens');
    }
    throw error;
  } finally {
    loopback.close();
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
