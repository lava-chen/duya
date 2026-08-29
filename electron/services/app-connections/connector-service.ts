/**
 * ConnectorService — main-process execution entry for connector tools.
 *
 * Plan 312 Phase 3. The agent process sends `appConnection:invoke`
 * requests via IPC; this service resolves the connection, acquires a
 * valid access token (refreshing if needed), dispatches the action to
 * the provider connector, and returns the (redacted) result.
 *
 * Tokens NEVER leave this module's call frame: the access token is
 * fetched from {@link TokenService}, passed directly to the connector
 * `invoke` method, and not included in the returned result.
 */

import { getLogger, LogComponent } from '../../logging/logger';
import { isToolGloballyApproved } from './tool-approvals.js';
import { isProviderEnabled, readAppPolicy } from './policy-gate.js';
import { AppConnectionService, getAppConnectionService } from './app-connection-service.js';
import { TokenService } from './token-service.js';
import type { ConnectorModule, ConnectorToolDescriptor, ConnectorInvokeResult } from './connector-types.js';
import { createGoogleConnector } from './connectors/google.js';
import { createSlackConnector } from './connectors/slack.js';
import { createMicrosoft365Connector } from './connectors/microsoft365.js';
import { createWeComConnector } from './connectors/wecom.js';
import { RemoteMcpConnector } from './connectors/remote-mcp.js';
import { getProviderConfig } from './providers/registry.js';
import {
  AppConnectorRegistry,
  declarativeDescriptors,
  getCustomConnectorFactory,
  registerCustomConnector,
} from './app-connector.js';
import { asAppConnectorId, type AppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';
import type {
  AppConnectionErrorCode,
  AppConnectionResult,
  ProviderId,
} from './types.js';

const COMPONENT = 'AppConnectionConnector' as LogComponent;

export interface ConnectorServiceDeps {
  /** Service singleton; defaults to {@link getAppConnectionService}. */
  service?: AppConnectionService;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Payload accepted by {@link ConnectorService.invoke}. */
export interface ConnectorInvokePayload {
  connectionId: string;
  action: string;
  args: unknown;
}

export class ConnectorService {
  private readonly logger = getLogger();
  private readonly service: AppConnectionService;
  /** Plan 455 D2: single resolution source for the connector catalog. */
  private readonly registry = new AppConnectorRegistry();
  private readonly remoteMcp: RemoteMcpConnector;
  private readonly fetchImpl: typeof fetch;
  private readonly customModules = new Map<AppConnectorId, ConnectorModule>();

  constructor(deps: ConnectorServiceDeps = {}) {
    this.service = deps.service ?? getAppConnectionService();
    this.remoteMcp = new RemoteMcpConnector(this.service.vault);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    // Plan 455 D4: first-party TS connectors are the ONLY custom-binding
    // residents. slack/microsoft365/google migrate to `rest` declarations
    // in Plan 460 Phase 2-4; wecom stays (CLI subprocess).
    registerCustomConnector(asAppConnectorId('google'), (d) => createGoogleConnector(d.fetchImpl));
    registerCustomConnector(asAppConnectorId('slack'), (d) => createSlackConnector(d.fetchImpl));
    registerCustomConnector(asAppConnectorId('microsoft365'), (d) => createMicrosoft365Connector(d.fetchImpl));
    registerCustomConnector(asAppConnectorId('wecom'), () => createWeComConnector(this.service.vault));
  }

  /** Test/loader seam: plugin `.app.json` declarations (Plan 455 Phase C). */
  get connectorRegistry(): AppConnectorRegistry {
    return this.registry;
  }

  /** Lazily instantiate (and cache) the custom module for a provider. */
  private customModule(provider: AppConnectorId): ConnectorModule | undefined {
    const cached = this.customModules.get(provider);
    if (cached) return cached;
    const factory = getCustomConnectorFactory(provider);
    if (!factory) return undefined;
    const module = factory({ fetchImpl: this.fetchImpl });
    this.customModules.set(provider, module);
    return module;
  }

  /**
   * List all tool descriptors for currently-connected connections.
   * Called by the init/reload payload builder so the agent process can
   * register discoverable tools. Descriptors contain NO tokens.
   */
  async listDescriptorsForConnected(): Promise<ConnectorToolDescriptor[]> {
    const out: ConnectorToolDescriptor[] = [];
    const policy = readAppPolicy();
    for (const dto of this.service.list()) {
      if (dto.status !== 'connected') continue;
      // Plan 450 (Phase C): exposure-layer policy gate. Disabled
      // providers are filtered BEFORE tools/list / descriptor emission
      // so the agent registry never sees them — mirroring codex's
      // `apps_enabled ? filter_codex_apps_mcp_tools : empty`.
      if (!isProviderEnabled(policy, dto.provider)) continue;
      // Plan 455 D2: one resolution instead of per-provider special cases.
      const resolution = this.registry.resolve(dto.provider);
      if (!resolution) {
        this.logger.warn(
          'App Connection: no connector registered for live connection',
          { connectionId: dto.id, provider: dto.provider },
          COMPONENT,
        );
        continue;
      }
      if (resolution.binding === 'mcp-remote') {
        const token = await this.service.getValidToken(dto.id);
        if (!token.success) {
          // Silent `continue` here left the agent's descriptor cache without
          // this provider while the UI still showed it as connected — the
          // model was then told the app was "not connected". At least log it.
          this.logger.warn(
            'App Connection: descriptor list skipped (no valid token)',
            { connectionId: dto.id, provider: dto.provider, code: token.error.code },
            COMPONENT,
          );
          continue;
        }
        try {
          out.push(...await this.remoteMcp.listDescriptors(dto.id, dto.provider, token.data));
        } catch (error) {
          this.logger.warn(
            'Remote MCP descriptor discovery failed',
            error instanceof Error ? error : new Error(String(error)),
            { connectionId: dto.id, provider: dto.provider },
            COMPONENT,
          );
        }
        continue;
      }
      if (resolution.binding === 'rest' && resolution.declaration) {
        // Plan 460 wires the generic invoker; descriptors are static
        // declaration data, so listing works before invoke lands.
        out.push(...declarativeDescriptors(resolution.declaration, dto.id));
        continue;
      }
      const connector = this.customModule(dto.provider);
      if (!connector) continue;
      out.push(...connector.listDescriptors(dto.id));
    }
    // Plan 449: stamp global "Always allow" decisions onto descriptors so
    // the agent-side permission gate can skip the write/modify ask without
    // an IPC round-trip. Destructive tiers are never stamped.
    // Plan 450 Phase G: also stamp the display label so the agent's Apps
    // system section and activation reminder can show `Notion`, not `notion`.
    for (const descriptor of out) {
      const resolution = this.registry.resolve(descriptor.provider);
      descriptor.providerLabel =
        resolution?.meta?.label ?? getProviderConfig(descriptor.provider)?.label;
      if (
        descriptor.riskTier !== 'destructive' &&
        isToolGloballyApproved(descriptor.provider, descriptor.name)
      ) {
        descriptor.preApproved = true;
      }
    }
    return out;
  }

  /**
   * Execute a connector tool call. The access token is acquired from
   * the token service, used for the single provider API call, then
   * discarded — it is never written into the returned result.
   */
  async invoke(payload: ConnectorInvokePayload): Promise<AppConnectionResult<unknown>> {
    const { connectionId, action, args } = payload;
    if (!connectionId || typeof connectionId !== 'string') {
      return failure('connection_not_found', 'connectionId is required', false);
    }

    const conn = this.service.getStatus(connectionId);
    if (!conn) {
      return failure('connection_not_found', `connection ${connectionId} not found`, false);
    }

    // Plan 455 D2: unified binding dispatch.
    const resolution = this.registry.resolve(conn.provider);
    if (!resolution) {
      return failure('unknown_action', `no connector for provider ${conn.provider}`, false);
    }
    if (resolution.binding === 'rest') {
      // Plan 460: generic REST template invoker. Until it lands, a
      // declared-but-unexecutable tool fails closed instead of throwing.
      return failure(
        'unknown_action',
        `REST template connector ${conn.provider} is not executable yet (Plan 460)`,
        false,
      );
    }

    // Custom-credential providers (e.g. WeCom) read their credentials from
    // the vault directly inside the connector; there is no OAuth token to
    // acquire. Skip the token service for them.
    const requiresOAuthClient =
      resolution.binding === 'custom'
        ? getProviderConfig(conn.provider)?.requiresOAuthClient !== false
        : true;
    const tokenResult = requiresOAuthClient
      ? await this.service.getValidToken(connectionId)
      : { success: true as const, data: { accessToken: '', tokenType: '', expiresAt: null } };
    if (!tokenResult.success) {
      this.logger.warn(
        'App Connection: invoke failed (no token)',
        { connectionId, provider: conn.provider, code: tokenResult.error.code },
        COMPONENT,
      );
      // Plan 450: mid-session auth failure → user-actionable auth_required.
      // Mid-session (the connection row was already 'connected' at start)
      // means refresh failed or the token was revoked server-side, so the
      // user must re-authorize before any tool in this connection works
      // again. Routes through the renderer auth card instead of surfacing
      // a generic connection_revoked dead-end.
      if (tokenResult.error.code === 'connection_revoked' ||
          (tokenResult.error.code === 'connection_not_available' && conn.status === 'connected')) {
        return failure(
          'connector_auth_required',
          `Re-authorization required for ${conn.provider}`,
          false,
        );
      }
      return failure(
        tokenResult.error.code,
        tokenResult.error.message,
        tokenResult.error.retriable,
      );
    }

    const startedAt = Date.now();
    let result: ConnectorInvokeResult;
    try {
      if (resolution.binding === 'mcp-remote') {
        result = await this.remoteMcp.invoke(connectionId, conn.provider, action, args, tokenResult.data);
      } else {
        const connector = this.customModule(conn.provider);
        if (!connector) {
          return failure('unknown_action', `no connector for provider ${conn.provider}`, false);
        }
        result = await connector.invoke(action, args, tokenResult.data.accessToken);
      }
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      this.logger.warn(
        'App Connection: connector invoke threw',
        err instanceof Error ? err : new Error(String(err)),
        { connectionId, provider: conn.provider, action, elapsedMs },
        COMPONENT,
      );
      return failure('internal', err instanceof Error ? err.message : String(err), false);
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.debug(
      'App Connection: connector invoke completed',
      {
        connectionId,
        provider: conn.provider,
        action,
        success: result.success,
        elapsedMs,
      },
      COMPONENT,
    );

    if (!result.success) {
      return failure(
        'provider_error',
        result.error?.message ?? 'unknown provider error',
        result.error?.retriable ?? false,
      );
    }

    return { success: true, data: result.data };
  }
}

function failure(
  code: AppConnectionErrorCode,
  message: string,
  retriable: boolean,
): AppConnectionResult<never> {
  return { success: false, error: { code, message, retriable } };
}

// --- Singleton ---

let singleton: ConnectorService | null = null;

export function getConnectorService(): ConnectorService {
  if (!singleton) {
    singleton = new ConnectorService();
  }
  return singleton;
}

export function _resetConnectorServiceSingleton(): void {
  singleton = null;
}
