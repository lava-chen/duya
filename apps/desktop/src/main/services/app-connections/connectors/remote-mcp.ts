/** Main-process bridge for official Remote MCP tools. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  deleteCatalogCache,
  isFresh,
  readCatalogCache,
  writeCatalogCache,
  type CachedSnapshot,
} from '../catalog-cache.js';
import type {
  ConnectorInputSchema,
  ConnectorInvokeResult,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId } from '../types.js';
import { getProviderConfig } from '../providers/registry.js';
import { createStoredRemoteMcpOAuthProvider } from '../oauth/remote-mcp-flow.js';
import type { TokenVault } from '../token-vault.js';
import {
  evaluateRemoteToolRiskTier,
  parseRemoteToolAnnotations,
  type RemoteToolAnnotations,
} from '../risk-policy.js';
import {
  listAllTools,
  formatDiscoveryLogLine,
  discoveryDebugEnabled,
} from '@duya/plugin-core/mcp/core/list-tools';
import {
  createDeadlineClock,
  deadlineClockFromIpc,
} from '@duya/plugin-core/mcp/core/deadline';
import {
  allocateConnectionToolAlias,
  connectionNamespace,
} from '@duya/plugin-core/mcp/core/alias';
import { InventoryLedger } from '@duya/plugin-core/mcp/core/ledger-types';
import { getLogger, LogComponent } from '../../../logging/logger';

const COMPONENT = 'AppConnectionConnector' as LogComponent;

/** Shared deadline for one full paginated `tools/list` pass (plan 580 D3/D5). */
const MCP_DISCOVERY_TIMEOUT_MS = 60_000;
/** Plan 580 D2: coalesce `notifications/tools/list_changed` bursts. */
const LIST_CHANGED_DEBOUNCE_MS = 500;

type HydratedTool = {
  description: string;
  /**
   * Plan 580 D4: CANONICAL input schema, verbatim from the server.
   * Never normalized / type-rewritten; the provider-facing projection is
   * generated at the last mile (agent-side `projectForProvider`).
   */
  inputSchema: Record<string, unknown> | undefined;
  annotations?: RemoteToolAnnotations;
};

interface RemoteSession {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Map<string, HydratedTool>;
  provider: ProviderId;
  /**
   * Plan 583 / ISS-22: the endpoint this session's transport is bound to.
   * Written into the catalog snapshot so a later session against a different
   * `remoteMcpUrl` cannot serve this one's tool list.
   */
  endpoint: string;
  /** True while a deliberate close() is in flight; onclose during it is not a death. */
  closing: boolean;
  /** Plan 580 D2: server capabilities from the initialize result (ledger). */
  serverCapabilities?: Record<string, unknown>;
  /**
   * Plan 580 D3 chain B inventory ledger, owned per session (see
   * `@duya/plugin-core/mcp/core/ledger-types.ts`). It is the single source of truth for discovery
   * state: pagesFetched / discoveredTotal / inventoryRevision / layers /
   * fetchedAt all live here, not as loose fields on this interface. Do not
   * flatten them back out 鈥?the snapshot returned by `getLedgerSnapshot()`
   * is consumed by `connector-service.ts:339`, and a flattened copy cannot
   * express the `complete` vs `stale` distinction that `commitDiscovery`
   * derives from `truncated`.
   */
  ledger: InventoryLedger;
  /** Monotonic guard: a late commit of a superseded discovery must lose. */
  rediscoveryGeneration: number;
  listChangedTimer: NodeJS.Timeout | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Plan 450 Phase E: hydrated tool shape used by both the live discovery
 * path and the catalog cache fast-path. Cache entries are hydrated
 * VERBATIM (plan 580 D4) 鈥?the legacy `normalizeInputSchema` rewrite is
 * gone; anything the server sent is what the agent sees.
 */
function hydrateTools(raw: CachedSnapshot['tools']): Map<string, HydratedTool> {
  return new Map(
    raw.map((tool) => [
      tool.name,
      {
        description: tool.description ?? '',
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
        annotations: parseRemoteToolAnnotations(tool.annotations),
      },
    ]),
  );
}

function toolAlias(provider: ProviderId, toolName: string, slug: string): string {
  // Plan 580 D7: Core allocator over the connection's stable namespace.
  // slug '' (the provider's first connection) reproduces the legacy
  // `remote_<provider>_<tool>` bytes byte-for-byte; derived slugs
  // address `remote_<provider>_<slug>_<tool>`.
  return allocateConnectionToolAlias(connectionNamespace(provider, slug), toolName, new Set());
}

/**
 * A Remote MCP is executed entirely in Electron main. The Agent receives only
 * a descriptor and redacted result through appConnection:invoke; the bearer
 * token is attached to the HTTP request in this class and never crosses IPC.
 */
export class RemoteMcpConnector {
  private readonly sessions = new Map<string, RemoteSession>();
  /**
   * Plan 583 / ISS-21: connects in flight, keyed by connection id. Without
   * this, two concurrent calls for the same connection both missed
   * `this.sessions`, each built its own `StreamableHTTPClientTransport`,
   * connected, and then raced on `this.sessions.set` 鈥?the loser's transport
   * and its server-side session were never closed. Callers now await one
   * shared connect.
   */
  private readonly connecting = new Map<string, Promise<RemoteSession>>();
  private readonly logger = getLogger();

  /**
   * Plan 580 D2: transport death hook. ConnectorService wires this to
   * AppConnectionService.markTransportDead so the connection status
   * stops claiming `connected` for a dead stream.
   */
  onTransportDead?: (connectionId: string, reason: string) => void;

  constructor(private readonly vault: TokenVault) {}

  async listDescriptors(
    connectionId: string,
    provider: ProviderId,
    token: { accessToken: string; tokenType: string },
    connectionSlug?: string,
  ): Promise<ConnectorToolDescriptor[]> {
    // Plan 580 D7: '' (pre-slug callers / the provider's first
    // connection) keeps the bare namespace; derived slugs flow through.
    const slug = connectionSlug ?? '';
    const session = await this.ensureSession(connectionId, provider, token);
    return [...session.tools.entries()].map(([name, tool]) => {
      // Plan 449: trust server-published hints for read-only tools instead of
      // prompting on every call. Anything uninformative stays `modify`.
      const { tier, source } = evaluateRemoteToolRiskTier(tool.annotations);
      return {
        name: toolAlias(provider, name, slug),
        description: tool.description || `${provider} Remote MCP tool: ${name}`,
        inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as ConnectorInputSchema,
        inputSchemaSummary: `Official ${provider} Remote MCP: ${name}`,
        riskTier: tier,
        tierSource: source,
        ...(tool.annotations?.title ? { title: tool.annotations.title } : {}),
        provider,
        connectionId,
        action: `remote:${name}`,
      };
    });
  }

  async invoke(
    connectionId: string,
    provider: ProviderId,
    action: string,
    args: unknown,
    token: { accessToken: string; tokenType: string },
    deadline?: { deadlineAt: number },
  ): Promise<ConnectorInvokeResult> {
    if (!action.startsWith('remote:')) {
      return { success: false, error: { code: 'unknown_action', message: 'Invalid Remote MCP action', retriable: false } };
    }
    const session = await this.ensureSession(connectionId, provider, token);
    const toolName = action.slice('remote:'.length);
    if (!session.tools.has(toolName)) {
      return { success: false, error: { code: 'unknown_action', message: `Remote MCP tool is unavailable: ${toolName}`, retriable: false } };
    }
    // Plan 580 D5: per-request deadline rides the SDK RequestOptions
    // (timeout + signal). The shared transport is NEVER closed for a
    // single aborted call; the SDK sends a per-request cancellation.
    const clock = deadline ? deadlineClockFromIpc(deadline.deadlineAt) : undefined;
    let result;
    try {
      result = await session.client.callTool(
        { name: toolName, arguments: isRecord(args) ? args : {} },
        CallToolResultSchema,
        clock ? { timeout: clock.remainingMs(), signal: clock.signal } : undefined,
      );
    } catch (error) {
      // Plan 450: mid-call auth failure (token revoked server-side after the
      // session cached the bearer). Surface a structured `connector_auth_required`
      // error so the agent-side executor can emit an elicitation event and the
      // renderer can prompt for re-authorization. The MCP SDK's authProvider
      // would otherwise loop on refresh attempts the user can't see.
      if (error instanceof UnauthorizedError) {
        return {
          success: false,
          error: {
            code: 'connector_auth_required',
            message: `Remote MCP session for ${provider} requires re-authorization`,
            retriable: false,
          },
        };
      }
      throw error;
    }
    return {
      success: !result.isError,
      data: {
        content: result.content,
        isError: result.isError === true,
      },
      ...(result.isError
        ? { error: { code: 'provider_error', message: `Remote MCP tool failed: ${toolName}`, retriable: false } }
        : {}),
    };
  }

  async disconnect(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    this.sessions.delete(connectionId);
    // Plan 450 Phase E: also drop the catalog snapshot so the next
    // re-authorization starts from a fresh tools/list rather than
    // reusing stale state.
    deleteCatalogCache(connectionId);
    if (!session) return;
    // Plan 580 D2: mark the deliberate close so the onclose handler does
    // not mistake it for a transport death, and drop pending notifications.
    session.closing = true;
    if (session.listChangedTimer) {
      clearTimeout(session.listChangedTimer);
      session.listChangedTimer = null;
    }
    await session.client.close().catch(() => undefined);
    await session.transport.close().catch(() => undefined);
  }

  /**
   * Plan 580 Phase 5: ledger snapshot for one live remote-MCP session.
   * `undefined` when the connection has no session (never connected or
   * dropped) 鈥?callers treat that as "no ledger data", not as a failure.
   */
  getLedgerSnapshot(connectionId: string): ReturnType<InventoryLedger['getSnapshot']> | undefined {
    return this.sessions.get(connectionId)?.ledger.getSnapshot();
  }

  private markTransportDead(connectionId: string, session: RemoteSession, reason: string): void {
    if (session.closing) return; // deliberate close during disconnect
    this.logger.warn(
      'Remote MCP transport died; dropping cached session',
      { connectionId, reason },
      COMPONENT,
    );
    this.sessions.delete(connectionId);
    if (session.listChangedTimer) {
      clearTimeout(session.listChangedTimer);
      session.listChangedTimer = null;
    }
    this.onTransportDead?.(connectionId, reason);
  }

  /**
   * Plan 580 D2: debounce-coalesced rediscovery after
   * `notifications/tools/list_changed`.
   */
  private scheduleRediscovery(connectionId: string, session: RemoteSession): void {
    if (session.listChangedTimer) clearTimeout(session.listChangedTimer);
    session.listChangedTimer = setTimeout(() => {
      session.listChangedTimer = null;
      void this.rediscover(connectionId, session);
    }, LIST_CHANGED_DEBOUNCE_MS);
  }

  private async rediscover(connectionId: string, session: RemoteSession): Promise<void> {
    session.ledger.beginDiscovery();
    try {
      await this.discoverNow(connectionId, session);
    } catch (err) {
      // Plan 580 D6: a failed refresh is NOT an authoritative empty 鈥?
      // keep the last-known inventory and mark it failed. The next
      // successful pass (or re-connect) is the only recovery path.
      session.ledger.failDiscovery();
      this.logger.warn(
        'Remote MCP rediscovery failed; keeping last-known inventory',
        { connectionId, provider: session.provider, err: String(err) },
        COMPONENT,
      );
    }
  }

  /**
   * Run one transactional paginated discovery (plan 580 D3) and commit it
   * into the session. Throws on failure 鈥?the caller decides whether the
   * failure is fatal (initial connect) or recoverable (rediscovery).
   */
  private async discoverNow(connectionId: string, session: RemoteSession): Promise<void> {
    const generation = ++session.rediscoveryGeneration;
    const deadline = createDeadlineClock(MCP_DISCOVERY_TIMEOUT_MS);
    const result = await listAllTools(session.client, {
      deadline,
      generation,
      ...(discoveryDebugEnabled() ? { debugLog: (message: string) => this.logger.info(message, undefined, COMPONENT) } : {}),
    });
    // Late-commit guard (plan 580 D3): a superseded discovery must lose.
    if (generation !== session.rediscoveryGeneration) return;

    session.tools = new Map(
      result.tools.map((tool) => [
        tool.name,
        {
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          annotations: parseRemoteToolAnnotations(tool.annotations),
        },
      ]),
    );
    session.ledger.commitDiscovery({
      pagesFetched: result.pagesFetched,
      discoveredTotal: result.discoveredTotal,
      truncated: result.truncated,
      ...(session.serverCapabilities ? { serverCapabilities: session.serverCapabilities } : {}),
    });

    this.logger.info(
      'Remote MCP discovery committed',
      {
        connectionId,
        provider: session.provider,
        detail: formatDiscoveryLogLine(result),
      },
      COMPONENT,
    );

    // Plan 580 D3: the catalog cache only accepts COMPLETE inventories 鈥?
    // a truncated pass is served but never persisted as authoritative.
    if (!result.truncated) {
      writeCatalogCache(
        connectionId,
        session.provider,
        session.endpoint,
        result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        })),
      );
    }
  }

  private async ensureSession(
    connectionId: string,
    provider: ProviderId,
    token: { accessToken: string; tokenType: string },
  ): Promise<RemoteSession> {
    const current = this.sessions.get(connectionId);
    if (current) return current;

    // Plan 583 / ISS-21: join an in-flight connect instead of starting a
    // second one. The entry is cleared in a finally so a failed connect never
    // poisons the connection id.
    const inFlight = this.connecting.get(connectionId);
    if (inFlight) return inFlight;

    const attempt = this.connectSession(connectionId, provider, token).finally(() => {
      this.connecting.delete(connectionId);
    });
    this.connecting.set(connectionId, attempt);
    return attempt;
  }

  private async connectSession(
    connectionId: string,
    provider: ProviderId,
    token: { accessToken: string; tokenType: string },
  ): Promise<RemoteSession> {
    const config = getProviderConfig(provider);
    if (!config?.remoteMcpUrl) throw new Error(`${provider} is not a Remote MCP provider`);

    const transport = new StreamableHTTPClientTransport(new URL(config.remoteMcpUrl), {
      authProvider: createStoredRemoteMcpOAuthProvider(this.vault, connectionId),
    });
    // Plan 580 D2 (erratum): `tools.listChanged` is a SERVER capability 鈥?
    // the MCP spec has no client-side `tools` capability and the SDK's
    // ClientCapabilitiesSchema rejects it. Client-side subscription is the
    // setNotificationHandler below; server intent is read from
    // getServerCapabilities() and saved for the ledger.
    const client = new Client({ name: 'duya-desktop', version: '0.1.0' }, { capabilities: {} });
    const session: RemoteSession = {
      client,
      transport,
      tools: new Map(),
      provider,
      endpoint: config.remoteMcpUrl,
      closing: false,
      // A fresh ledger starts at `failed`; mark the connect attempt in flight
      // so a session that has not committed yet does not read as failed.
      ledger: new InventoryLedger(),
      rediscoveryGeneration: 0,
      listChangedTimer: null,
    };
    session.ledger.beginDiscovery();
    try {
      await client.connect(transport);

      // Plan 580 D2: transport death 鈫?drop the session and notify the
      // service layer. No auto-reconnect; the next invoke re-connects.
      transport.onclose = () => this.markTransportDead(connectionId, session, 'transport closed');
      transport.onerror = (err) => this.markTransportDead(connectionId, session, `transport error: ${err}`);

      try {
        const caps = client.getServerCapabilities();
        if (caps && typeof caps === 'object') {
          session.serverCapabilities = caps as Record<string, unknown>;
        }
      } catch {
        // capability probe is best-effort
      }

      // Plan 580 D2: react to server-side tool list changes.
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.scheduleRediscovery(connectionId, session);
      });

      // Plan 450 Phase E: try the persistent catalog cache first so cold
      // starts don't pay the network round-trip on every session. Stale
      // entries re-fetch foreground; fresh entries skip discovery. The
      // transport/auth is still set up either way.
      //
      // Plan 583 / ISS-22: the snapshot is only usable when it came from the
      // endpoint we are connected to right now. Matching on `provider` alone
      // let a snapshot survive a change of `remoteMcpUrl` and keep serving the
      // previous server's tool list.
      const cached = readCatalogCache(connectionId);
      const cacheMatchesEndpoint =
        cached !== null &&
        cached.provider === provider &&
        cached.endpoint === config.remoteMcpUrl;
      if (cacheMatchesEndpoint && isFresh(cached) && cached.tools.length > 0) {
        session.tools = hydrateTools(cached.tools);
        session.ledger.hydrateFromCache(session.tools.size);
      } else {
        await this.discoverNow(connectionId, session);
      }

      this.sessions.set(connectionId, session);
      return session;
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
}
