/**
 * AppConnectionService — main-process singleton facade. Plan 312 Phase 1.
 *
 * Composes {@link ConnectionStore}, {@link TokenVault},
 * {@link TokenService}, and the OAuth flow orchestrator into a single
 * surface used by the IPC layer and the connector service.
 *
 * Boundaries enforced here:
 *   - Every public method returning connection data returns a DTO
 *     ({@link AppConnectionStatusDTO}); tokens NEVER cross this surface.
 *   - `disconnect` clears both the vault entry and the DB row, then
 *     fires the reload hook so agent tools go offline.
 *   - The OAuth flow is dispatched through {@link startAuthorization};
 *     this service injects the vault + store callbacks.
 *
 * The singleton is lazily created via {@link getAppConnectionService}
 * so test code can construct isolated instances directly.
 */

import { randomUUID } from 'node:crypto';

import { getDatabase } from '../../db/connection.js';
import { getLogger, LogComponent } from '../../logging/logger';
import { ConnectionStore } from './connection-store.js';
import { TokenVault } from './token-vault.js';
import { TokenService } from './token-service.js';
import { startAuthorization, FlowError } from './oauth/flow.js';
import { startRemoteMcpAuthorization } from './oauth/remote-mcp-flow.js';
import type { RemoteMcpConnector } from './connectors/remote-mcp.js';
import {
  clearClientSecret,
  getProviderConfig,
  getProviderReadiness,
  listProviders,
  overrideClientId,
  setClientSecret,
} from './providers/registry.js';
import { disconnectMcpSession } from './connector-service.js';
import { asAppConnectorId } from '@duya/plugin-core/connectors/app-connector-id';
import type {
  AppConnection,
  AppConnectionStatusDTO,
  AppConnectionProviderDTO,
  AppConnectionResult,
  ManualProviderCredentials,
  ProviderId,
} from './types.js';
import { toStatusDTO } from './types.js';

const WECOM_PROVIDER = asAppConnectorId('wecom');
const QQ_MAIL_PROVIDER = asAppConnectorId('qq-mail');

const COMPONENT = 'AppConnectionService' as LogComponent;

/**
 * Hook fired after a connect/disconnect completes. The IPC layer
 * installs the agent-reload broadcaster here (mirrors
 * `notifyMcpConfigChanged` from mcp-write-reload.ts).
 */
export type ReloadBroadcastHook = () => Promise<void>;

/**
 * Plan 312 Phase 4: provider block check callback. The IPC layer
 * wires this to `PolicyEngine.isProviderBlocked`. Kept as a callback
 * (not a direct PolicyEngine import) so the service stays testable
 * without constructing a full policy engine.
 */
export type ProviderBlockCheck = (
  providerId: ProviderId,
) => { allowed: boolean; reason?: string };

export interface AppConnectionServiceDeps {
  store?: ConnectionStore;
  vault?: TokenVault;
  tokenService?: TokenService;
  fetchImpl?: typeof fetch;
  /**
   * Plan 312 Phase 4: enterprise policy gate. When present, `connect`
   * calls this before starting the OAuth flow and throws if the
   * provider is blocked. The policy schema + UI belong to Plan 92.
   */
  isProviderBlocked?: ProviderBlockCheck;
}

export class AppConnectionService {
  private readonly logger = getLogger();
  readonly vault: TokenVault;
  private readonly _store: ConnectionStore | undefined;
  private readonly _tokenService: TokenService | undefined;
  private readonly fetchImpl: typeof fetch;
  private reloadHook: ReloadBroadcastHook | null = null;
  private readonly providerBlockCheck?: ProviderBlockCheck;
  /**
   * Remote MCP connector installed by ConnectorService via
   * {@link setRemoteMcpConnector}. Used by the silent reconnect path in
   * {@link connect} to re-establish a session using the existing
   * connectionId + stored refresh token, instead of forcing the user
   * through a full browser OAuth flow after every restart.
   */
  private remoteMcp: RemoteMcpConnector | null = null;

  constructor(deps: AppConnectionServiceDeps = {}) {
    this.vault = deps.vault ?? new TokenVault();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    // Store / tokenService are lazily resolved at call time (not at module-
    // import time) so that `getDatabase()` is guaranteed to be non-null by
    // the time any method body runs.  This mirrors the defensive pattern in
    // `getReadyAppConnectionService()` in the IPC layer.
    this._store = deps.store;
    this._tokenService = deps.tokenService;
    this.providerBlockCheck = deps.isProviderBlocked;
    this.hydrateProviderClients();
  }

  /** Lazy store — resolves the DB connection at first use, not at construction. */
  private get _connectionStore(): ConnectionStore {
    if (this._store) return this._store;
    const db = getDatabase();
    if (!db) throw new Error('App connection database is not ready');
    return new ConnectionStore(db);
  }

  /** Lazy tokenService — depends on the store, so also resolved lazily. */
  private get _svc(): TokenService {
    if (this._tokenService) return this._tokenService;
    return new TokenService({
      store: this._connectionStore,
      vault: this.vault,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Install the post-mutation reload hook (called by IPC layer). */
  setReloadHook(hook: ReloadBroadcastHook): void {
    this.reloadHook = hook;
  }

  /**
   * Install the shared RemoteMcpConnector instance so this service can
   * call `ensureSession` with the existing connectionId + stored refresh
   * token (see {@link connect}). ConnectorService owns the connector
   * lifecycle and calls this once during its own construction.
   */
  setRemoteMcpConnector(connector: RemoteMcpConnector): void {
    this.remoteMcp = connector;
  }

  /** List all connections as renderer-safe DTOs. */
  list(): AppConnectionStatusDTO[] {
    return this._connectionStore.list().map(toStatusDTO);
  }

  /** List connections for a single provider (renderer-safe DTOs). */
  listByProvider(provider: ProviderId): AppConnectionStatusDTO[] {
    return this._connectionStore.listByProvider(provider).map(toStatusDTO);
  }

  /** List built-in providers without exposing OAuth client secrets. */
  listProviders(): AppConnectionProviderDTO[] {
    this.hydrateProviderClients();
    return listProviders().map((provider) => {
      const readiness = getProviderReadiness(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        configured: readiness.configured,
        configurationHint: provider.manualConfigHint ?? readiness.reason,
        supportsManualConfiguration: provider.supportsManualConfiguration,
        requiresClientSecret: provider.requiresClientSecret,
        monogram: provider.monogram,
        description: provider.description,
        scopes: provider.defaultScopes,
      };
    });
  }

  /**
   * Persist a user-owned OAuth client in the encrypted vault. This is the
   * escape hatch for self-hosted/development builds; official builds provide
   * their reviewed client configuration at packaging time.
   */
  configureProvider(
    provider: ProviderId,
    credentials: { clientId: string; clientSecret?: string },
  ): AppConnectionProviderDTO {
    const providerConfig = getProviderConfig(provider);
    if (!providerConfig) {
      throw new FlowError('provider_not_configured', `${provider} is not a registered connector`);
    }
    if (!providerConfig.supportsManualConfiguration) {
      throw new FlowError(
        'provider_not_configured',
        `${providerConfig.label} uses Duya-managed OAuth and does not accept a manual client ID`,
      );
    }
    const clientId = credentials.clientId.trim();
    if (!clientId) {
      throw new FlowError('provider_not_configured', 'OAuth client ID is required');
    }
    if (providerConfig.requiresClientSecret && !credentials.clientSecret?.trim()) {
      throw new FlowError(
        'provider_not_configured',
        `${providerConfig.label} requires an OAuth client secret at the token endpoint`,
      );
    }
    this.vault.setOAuthClient(provider, {
      clientId,
      ...(credentials.clientSecret?.trim() ? { clientSecret: credentials.clientSecret.trim() } : {}),
    });
    this.hydrateProviderClients();
    const readiness = getProviderReadiness(provider);
    const config = getProviderConfig(provider);
    if (!config) {
      throw new FlowError('provider_not_configured', `${provider} is not a registered connector`);
    }
    return {
      id: provider,
      label: config.label,
      configured: readiness.configured,
      configurationHint: config.manualConfigHint ?? readiness.reason,
      supportsManualConfiguration: config.supportsManualConfiguration,
      requiresClientSecret: config.requiresClientSecret,
      monogram: config.monogram,
      description: config.description,
      scopes: config.defaultScopes,
    };
  }

  /** Get a single connection's status DTO. */
  getStatus(connectionId: string): AppConnectionStatusDTO | null {
    const conn = this._connectionStore.get(connectionId);
    return conn ? toStatusDTO(conn) : null;
  }

  /**
   * Start the OAuth authorization flow for a provider. Resolves with
   * the new connection's status DTO. Rejects with {@link FlowError}
   * (or a generic Error) on failure.
   *
   * Plan 312 Phase 4: if a provider block check is installed, it runs
   * BEFORE any network activity. Blocked providers throw immediately.
   */
  /**
   * Connect a custom-credential provider (WeCom) with manual credentials.
   *
   * Unlike OAuth providers, WeCom has no authorization-code flow: the user
   * supplies a self-built enterprise app's `corpid` + `corpsecret`. We store
   * them in the vault's per-provider OAuth-client slot and upsert a connected
   * AppConnection so the connector's descriptors come online after reload.
   *
   * The credentials never cross IPC into the renderer — only the idempotent
   * status DTO is returned.
   */
  async connectWeCom(
    credentials: ManualProviderCredentials,
  ): Promise<AppConnectionStatusDTO> {
    const corpid = credentials.clientId.trim();
    const corpsecret = credentials.clientSecret.trim();
    if (!corpid || !corpsecret) {
      throw new FlowError('provider_not_configured', 'corpid and corpsecret are required');
    }
    if (this.providerBlockCheck) {
      const gate = this.providerBlockCheck(WECOM_PROVIDER);
      if (!gate.allowed) {
        throw new FlowError('provider_blocked', gate.reason ?? 'wecom is blocked by enterprise policy');
      }
    }

    // Persist the enterprise credentials in the encrypted vault (per-provider).
    this.vault.setOAuthClient(WECOM_PROVIDER, { clientId: corpid, clientSecret: corpsecret });

    // Upsert a connected connection for provider wecom so the connector's
    // descriptors surface after reload. Reuse any existing wecom connection id.
    const existing = this._connectionStore.listByProvider(WECOM_PROVIDER)[0];
    const conn: AppConnection = {
      id: existing?.id ?? `wecom-${randomUUID().slice(0, 8)}`,
      provider: WECOM_PROVIDER,
      accountLabel: `WeCom enterprise ${corpid}`,
      accountId: corpid,
      scopes: [],
      status: 'connected',
      expiresAt: null,
      lastError: null,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this._connectionStore.upsert(conn);

    this.logger.info(
      'App Connection: connected wecom (manual credentials)',
      { connectionId: conn.id, provider: 'wecom' },
      COMPONENT,
    );

    await this.fireReload();
    return toStatusDTO(this._connectionStore.get(conn.id)!);
  }

  /**
   * Connect a custom-credential provider (QQ Mail) with an email address and a
   * 16-digit authorization code (granted in QQ Mail web settings).
   *
   * Mirrors {@link connectWeCom}: no OAuth flow; the credentials are stored in
   * the vault's per-provider OAuth-client slot (clientId = email, clientSecret =
   * auth code) and a connected AppConnection is upserted so the qq-mail IMAP/SMTP
   * tools come online after reload. Only the idempotent status DTO crosses IPC —
   * the auth code never reaches the renderer.
   */
  async connectQqMail(payload: {
    email: string;
    authCode: string;
  }): Promise<AppConnectionStatusDTO> {
    const email = payload.email.trim();
    const authCode = payload.authCode.trim();
    if (!email || !authCode) {
      throw new FlowError('provider_not_configured', 'QQ Mail email address and authorization code are required');
    }
    if (this.providerBlockCheck) {
      const gate = this.providerBlockCheck(QQ_MAIL_PROVIDER);
      if (!gate.allowed) {
        throw new FlowError('provider_blocked', gate.reason ?? 'qq-mail is blocked by enterprise policy');
      }
    }

    this.vault.setOAuthClient(QQ_MAIL_PROVIDER, { clientId: email, clientSecret: authCode });

    const existing = this._connectionStore.listByProvider(QQ_MAIL_PROVIDER)[0];
    const conn: AppConnection = {
      id: existing?.id ?? `qq-mail-${randomUUID().slice(0, 8)}`,
      provider: QQ_MAIL_PROVIDER,
      accountLabel: `QQ 邮箱 ${email}`,
      accountId: email,
      scopes: [],
      status: 'connected',
      expiresAt: null,
      lastError: null,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this._connectionStore.upsert(conn);

    this.logger.info(
      'App Connection: connected qq-mail (manual credentials)',
      { connectionId: conn.id, provider: 'qq-mail' },
      COMPONENT,
    );

    await this.fireReload();
    return toStatusDTO(this._connectionStore.get(conn.id)!);
  }

  /**
   * Connect a provider via OAuth (authorization-code flow) or remote MCP.
   * Dispatched for OAuth providers; custom-credential providers use
   * {@link connectWeCom} instead.
   */
  async connect(
    provider: ProviderId,
    scopes?: string[],
  ): Promise<AppConnectionStatusDTO> {
    this.hydrateProviderClients();
    // Plan 312 Phase 4: enterprise policy gate.
    if (this.providerBlockCheck) {
      const result = this.providerBlockCheck(provider);
      if (!result.allowed) {
        this.logger.warn(
          'App Connection: connect blocked by policy',
          { provider, reason: result.reason },
          COMPONENT,
        );
        throw new FlowError(
          'provider_blocked',
          result.reason ?? `provider ${provider} is blocked by enterprise policy`,
        );
      }
    }

    try {
      const config = getProviderConfig(provider);
      if (!config) {
        throw new FlowError('provider_not_configured', `${provider} is not a registered connector`);
      }

      // Plan (silent reconnect): for remote MCP providers, prefer reusing
      // the existing connectionId + stored refresh token over forcing the
      // user through the browser OAuth flow after every transport death.
      // The MCP SDK refreshes the access token silently using the stored
      // refresh token; only fall back to OAuth if no token is stored or the
      // provider rejects the refresh.
      if (config.remoteMcpUrl) {
        const silent = await this.trySilentReconnectRemoteMcp(provider, config, scopes);
        if (silent) {
          await this.fireReload();
          return silent;
        }
      }

      const dto = config.remoteMcpUrl
        ? await startRemoteMcpAuthorization(provider, {
            store: this._connectionStore,
            vault: this.vault,
          })
        : await startAuthorization(provider, {
            upsertConnection: (conn) => this._connectionStore.upsert(conn),
            storeTokens: (id, tokens) => this.vault.set(id, tokens),
          }, {
            scopes,
            fetchImpl: this.fetchImpl,
          });

      // After a fresh OAuth, scrub any `error`-status rows left over from
      // prior transport deaths. Without this, every restart+reconnect cycle
      // would accumulate one stale DB row plus an orphaned vault token pair.
      if (config.remoteMcpUrl) {
        this.cleanupStaleRemoteMcpConnections(provider, dto.id);
      }

      await this.fireReload();
      return dto;
    } catch (err) {
      if (err instanceof FlowError) {
        this.logger.warn(
          'App Connection: connect failed',
          { code: err.code, message: err.message, provider },
          COMPONENT,
        );
      } else {
        this.logger.error(
          'App Connection: connect failed (unexpected)',
          err instanceof Error ? err : new Error(String(err)),
          { provider },
          COMPONENT,
        );
      }
      throw err;
    }
  }

  /**
   * Plan (silent reconnect): try to bring a `Remote MCP` connection back
   * to `connected` using the connection's stored refresh token, without
   * launching the browser OAuth flow. Returns the refreshed status DTO
   * on success, or `null` to signal the caller to fall back to OAuth.
   *
   * Pre-conditions for the silent path:
   *   - The connector was installed via {@link setRemoteMcpConnector}.
   *   - The provider has a `remoteMcpUrl` (already enforced by the caller).
   *   - A prior connection row exists for this provider.
   *   - The vault still holds a refresh token under that connectionId.
   *
   * Failure modes (all fall back to OAuth):
   *   - No stored token (first-time connect after reset/reinstall).
   *   - MCP SDK rejected the refresh token (revoked / password changed).
   *   - The provider's MCP endpoint is unreachable.
   */
  private async trySilentReconnectRemoteMcp(
    provider: ProviderId,
    config: { remoteMcpUrl: string; [k: string]: unknown },
    scopes?: string[],
  ): Promise<AppConnectionStatusDTO | null> {
    if (!this.remoteMcp || !config?.remoteMcpUrl) return null;

    // Prefer an `error`-status row (transport died) over any other row, since
    // that is the exact recovery scenario this helper targets. Fall back to
    // any row with stored tokens so a `disconnected` row also gets a chance.
    // Note: TokenSet uses camelCase (`refreshToken`), not snake_case.
    const candidates = this._connectionStore.listByProvider(provider);
    const target =
      candidates.find(
        (c) => c.status === 'error' && this.vault.get(c.id)?.refreshToken,
      ) ??
      candidates.find((c) => this.vault.get(c.id)?.refreshToken);
    if (!target) return null;

    try {
      await this.remoteMcp.ensureSession(target.id, config, scopes);
      this._connectionStore.updateStatus(target.id, 'connected', {
        lastError: null,
      });
      const refreshed = this._connectionStore.get(target.id);
      if (!refreshed) return null;
      this.logger.info(
        'App Connection: silent reconnect succeeded',
        { provider, connectionId: target.id },
        COMPONENT,
      );
      return toStatusDTO(refreshed);
    } catch (err) {
      this.logger.warn(
        'App Connection: silent reconnect failed; falling back to OAuth',
        { provider, connectionId: target.id },
        COMPONENT,
      );
      this.logger.debug(
        'App Connection: silent reconnect error detail',
        { error: err instanceof Error ? err.message : String(err) },
        COMPONENT,
      );
      return null;
    }
  }

  /**
   * After a fresh OAuth succeeds for a remote MCP provider, delete any
   * leftover `error`-status rows for the same provider. Each row may also
   * have orphaned token blobs in the vault (left over from the randomUUID
   * dance in {@link startRemoteMcpAuthorization}); drop those too so they
   * don't accumulate forever.
   */
  private cleanupStaleRemoteMcpConnections(
    provider: ProviderId,
    keepConnectionId: string,
  ): void {
    const stale = this._connectionStore
      .listByProvider(provider)
      .filter((c) => c.id !== keepConnectionId && c.status === 'error');
    if (stale.length === 0) return;
    for (const row of stale) {
      this._connectionStore.remove(row.id);
      this.vault.remove(row.id);
      this.vault.removeMcpOAuth(row.id);
    }
    this.logger.info(
      'App Connection: cleaned up stale remote MCP connection rows',
      { provider, removed: stale.length },
      COMPONENT,
    );
  }

  /**
   * Plan (boot rehydrate): silently restore remote MCP sessions that
   * died during the previous run, using the stored refresh token +
   * dynamic client identity stored alongside it. Intended to be called
   * once during app boot (after {@link reconcilePluginAppDeclarations})
   * so connections come back to `connected` without forcing a browser
   * OAuth flow.
   *
   * Design constraints (plan 580 D2 — kept):
   *   - Never opens the browser; only reuses stored credentials.
   *   - Failures are non-fatal — leaves rows in `error` so the UI can
   *     still surface the message and the user can force a re-auth via
   *     the toggle.
   *   - Skips rows that have no refresh token (the user previously
   *     revoked or never finished an OAuth flow).
   *
   * Walks every provider with a `remoteMcpUrl` and every existing row
   * for that provider, regardless of stored status (`connected` rows
   * whose transport died without `onTransportDead` firing also count).
   * Skips rows for providers that have no remote MCP endpoint — those
   * have their own recovery path through the OAuth flow.
   */
  async rehydrateRemoteMcpConnections(): Promise<void> {
    if (!this.remoteMcp) return;
    for (const provider of listProviders()) {
      if (!provider.remoteMcpUrl) continue;
      const candidates = this._connectionStore.listByProvider(provider.id);
      for (const conn of candidates) {
        const stored = this.vault.get(conn.id);
        if (!stored?.refreshToken) continue;
        try {
          await this.remoteMcp.ensureSession(conn.id, provider, conn.scopes);
          this._connectionStore.updateStatus(conn.id, 'connected', {
            lastError: null,
          });
          this.logger.info(
            'App Connection: boot rehydrate succeeded',
            { provider: provider.id, connectionId: conn.id },
            COMPONENT,
          );
        } catch (err) {
          this.logger.warn(
            'App Connection: boot rehydrate failed (non-fatal)',
            { provider: provider.id, connectionId: conn.id },
            COMPONENT,
          );
          this.logger.debug(
            'App Connection: boot rehydrate error detail',
            {
              error:
                err instanceof Error ? err.message : String(err),
            },
            COMPONENT,
          );
        }
      }
    }
  }

  /**
   * Disconnect a connection:
   *   1. Best-effort call the provider revoke endpoint.
   *   2. Remove the token set from the vault.
   *   3. Set the connection status to `disconnected`.
   *   4. Fire the reload hook so agent-side tools go offline.
   *
   * Returns true if a connection existed (regardless of revoke success).
   */
  async disconnect(connectionId: string): Promise<boolean> {
    const conn = this._connectionStore.get(connectionId);
    if (!conn) {
      return false;
    }

    // 1) Best-effort revoke at the provider.
    await this.revokeAtProvider(conn.provider, connectionId);

    // 2) Clear vault entry.
    this.vault.remove(connectionId);
    this.vault.removeMcpOAuth(connectionId);

    // 3) Mark disconnected in DB.
    this._connectionStore.updateStatus(connectionId, 'disconnected', {
      expiresAt: null,
      lastError: null,
    });

    this.logger.info(
      'App Connection: disconnected',
      { connectionId, provider: conn.provider },
      COMPONENT,
    );

    await this.fireReload();
    return true;
  }

  /**
   * Remove a connection and its local secrets. Custom-credential providers
   * store account credentials by provider, so those are cleared as well.
   * Provider token revocation is best-effort and does not block cleanup.
   */
  async remove(connectionId: string): Promise<boolean> {
    const conn = this._connectionStore.get(connectionId);
    if (!conn) {
      return false;
    }

    // Start provider revocation while the token is still available, but do not
    // wait for the provider network request before deleting local state.
    void this.revokeAtProvider(conn.provider, connectionId).catch((err) => {
      this.logger.warn(
        'App Connection: revoke failed during removal (non-fatal)',
        err instanceof Error ? err : new Error(String(err)),
        { connectionId, provider: conn.provider },
        COMPONENT,
      );
    });

    this.vault.remove(connectionId);
    this.vault.removeMcpOAuth(connectionId);
    // Also clear any cached Remote MCP session so a future reconnect
    // starts fresh instead of reusing a stale session (bug fix).
    void disconnectMcpSession(connectionId);

    if (conn.provider === WECOM_PROVIDER || conn.provider === QQ_MAIL_PROVIDER) {
      this.vault.removeOAuthClient(conn.provider);
    }
    const removed = this._connectionStore.remove(connectionId);
    if (!removed) {
      return false;
    }

    this.logger.info(
      'App Connection: removed',
      { connectionId, provider: conn.provider },
      COMPONENT,
    );

    void this.fireReload();
    return true;
  }

  /**
   * Plan 580 D2 (chain B lifecycle truth): the Remote MCP stream died
   * (transport `onclose`/`onerror` while not disconnecting). Mark the
   * connection `error` so the UI stops claiming `connected` for a dead
   * stream. Only a live `connected` row degrades — never overwrite
   * `revoked` / `expired` / user-driven states. Recovery is implicit:
   * the next invoke re-connects (see RemoteMcpConnector.ensureSession).
   */
  async markTransportDead(connectionId: string, reason: string): Promise<void> {
    const conn = this._connectionStore.get(connectionId);
    if (!conn || conn.status !== 'connected') return;
    this._connectionStore.updateStatus(connectionId, 'error', {
      lastError: `Remote MCP stream died: ${reason}`,
    });
    this.logger.warn(
      'App Connection: remote MCP transport died; connection marked error',
      { connectionId, provider: conn.provider, reason },
      COMPONENT,
    );
    await this.fireReload();
  }

  /** Best-effort token revocation at the provider. Never throws. */
  private async revokeAtProvider(provider: ProviderId, connectionId: string): Promise<void> {
    const config = getProviderConfig(provider);
    if (!config?.revokeUrl) {
      return;
    }
    const tokens = this.vault.get(connectionId);
    if (!tokens) {
      return;
    }
    try {
      // Google: POST with token+token_type_hint in body.
      // Slack: GET with token in query (auth.revoke).
      // Both accept a simple form post; if a provider diverges, add a
      // per-provider revoke fn later.
      const resp = await this.fetchImpl(config.revokeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          token: tokens.accessToken,
          token_type_hint: 'access_token',
        }).toString(),
      });
      if (!resp.ok) {
        this.logger.warn(
          'App Connection: revoke endpoint non-OK',
          { provider, status: resp.status },
          COMPONENT,
        );
      }
    } catch (err) {
      // Best-effort; do not block disconnect on revoke failure.
      this.logger.warn(
        'App Connection: revoke failed (non-fatal)',
        err instanceof Error ? err : new Error(String(err)),
        { provider },
        COMPONENT,
      );
    }
  }

  /**
   * Acquire a valid token for an outgoing provider API call. Used
   * by the connector service. Returns a structured result; tokens
   * stay inside the main process.
   */
  async getValidToken(
    connectionId: string,
  ): Promise<AppConnectionResult<{ accessToken: string; tokenType: string; expiresAt: number | null }>> {
    return this._svc.getValidToken(connectionId);
  }

  private async fireReload(): Promise<void> {
    if (!this.reloadHook) return;
    try {
      await this.reloadHook();
    } catch (err) {
      this.logger.warn(
        'App Connection: reload hook failed (non-fatal)',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        COMPONENT,
      );
    }
  }

  private hydrateProviderClients(): void {
    for (const provider of listProviders()) {
      // Remote MCP providers dynamically register a public client during the
      // OAuth flow. They never consume a user-supplied OAuth client config.
      if (provider.remoteMcpUrl) continue;
      // A few focused service tests inject a minimal vault double that only
      // implements token operations. Treat it as an empty OAuth-client vault.
      const credentials = this.vault.getOAuthClient?.(provider.id);
      if (!credentials) continue;
      overrideClientId(provider.id, credentials.clientId);
      if (credentials.clientSecret) {
        setClientSecret(provider.id, credentials.clientSecret);
      } else {
        clearClientSecret(provider.id);
      }
    }
  }
}

// --- Singleton ---

let singleton: AppConnectionService | null = null;

/** Get the shared AppConnectionService singleton. */
export function getAppConnectionService(): AppConnectionService {
  if (!singleton) {
    singleton = new AppConnectionService();
  }
  return singleton;
}

/**
 * Reset the singleton — test-only escape hatch. Tests that construct
 * isolated service instances with in-memory deps should call this to
 * avoid leaking state across test files.
 */
export function _resetAppConnectionServiceSingleton(): void {
  singleton = null;
}
