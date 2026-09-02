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
import {
  clearClientSecret,
  getProviderConfig,
  getProviderReadiness,
  listProviders,
  overrideClientId,
  setClientSecret,
} from './providers/registry.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';
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
        configurationHint: readiness.reason,
        supportsManualConfiguration: provider.supportsManualConfiguration,
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
      configurationHint: readiness.reason,
      supportsManualConfiguration: config.supportsManualConfiguration,
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
