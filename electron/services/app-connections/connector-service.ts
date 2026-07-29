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
import { AppConnectionService, getAppConnectionService } from './app-connection-service.js';
import { TokenService } from './token-service.js';
import type { ConnectorModule, ConnectorToolDescriptor, ConnectorInvokeResult } from './connector-types.js';
import { createGoogleConnector } from './connectors/google.js';
import { createSlackConnector } from './connectors/slack.js';
import { createMicrosoft365Connector } from './connectors/microsoft365.js';
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
  private readonly connectors: Map<ProviderId, ConnectorModule>;

  constructor(deps: ConnectorServiceDeps = {}) {
    this.service = deps.service ?? getAppConnectionService();
    const fetchImpl = deps.fetchImpl ?? fetch;
    this.connectors = new Map<ProviderId, ConnectorModule>([
      ['google', createGoogleConnector(fetchImpl)],
      ['slack', createSlackConnector(fetchImpl)],
      ['microsoft365', createMicrosoft365Connector(fetchImpl)],
    ]);
  }

  /**
   * List all tool descriptors for currently-connected connections.
   * Called by the init/reload payload builder so the agent process can
   * register discoverable tools. Descriptors contain NO tokens.
   */
  listDescriptorsForConnected(): ConnectorToolDescriptor[] {
    const out: ConnectorToolDescriptor[] = [];
    for (const dto of this.service.list()) {
      if (dto.status !== 'connected') continue;
      const connector = this.connectors.get(dto.provider);
      if (!connector) continue;
      out.push(...connector.listDescriptors(dto.id));
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

    const connector = this.connectors.get(conn.provider);
    if (!connector) {
      return failure('unknown_action', `no connector for provider ${conn.provider}`, false);
    }

    // Acquire a valid token (may refresh). Token stays in this frame.
    const tokenResult = await this.service.getValidToken(connectionId);
    if (!tokenResult.success) {
      this.logger.warn(
        'App Connection: invoke failed (no token)',
        { connectionId, provider: conn.provider, code: tokenResult.error.code },
        COMPONENT,
      );
      return failure(
        tokenResult.error.code,
        tokenResult.error.message,
        tokenResult.error.retriable,
      );
    }

    const startedAt = Date.now();
    let result: ConnectorInvokeResult;
    try {
      result = await connector.invoke(action, args, tokenResult.data.accessToken);
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
