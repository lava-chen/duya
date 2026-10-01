/**
 * MCP Client - Model Context Protocol Client
 * Manages MCP server connections and tool calls
 *
 * Plan 580: transactional paginated discovery (D3), lifecycle truth
 * (D2 — list_changed / onclose / onerror → degraded), single-deadline
 * per-request abort (D5 — never closes a shared transport), canonical
 * result blocks (D8), and error classification / breaker decoupling
 * (D9) — all via the protocol-pure primitives in
 * `@duya/plugin-core/src/mcp/core/`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolResult, MCPServerConfig, MCPConnectionStatus } from '../types.js';
import { logger } from '../utils/logger.js';
import { getCircuitBreakerManager, type CircuitBreaker } from './circuit-breaker.js';
import { buildSafeEnv, sanitizeSecrets, scanMcpDescription } from './security.js';
import { InventoryLedger } from '@duya/plugin-core/src/mcp/core/ledger-types.js';
import {
  listAllTools,
  formatDiscoveryLogLine,
  discoveryDebugEnabled,
  createDeadlineClock,
  classifyMcpError,
  breakerDisposition,
  errorCodeForClass,
  McpError,
} from '@duya/plugin-core/src/mcp/core/index.js';
import { composeResultFromBlocks } from './result-blocks.js';

// Three-level timeout defaults (seconds). A server may override each
// level via config: `startupTimeoutSec`, `toolTimeoutSec`, and
// `toolTimeouts` (per-tool). These are the fallbacks when unset.
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000; // 30s: spawn + handshake + listTools
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;   // 120s: default per-tool-call cap

/** Plan 580 D2: debounce window for coalescing `tools/list_changed`. */
const LIST_CHANGED_DEBOUNCE_MS = 500;

/** Convert an optional seconds value to ms, falling back to `fallback`. */
function timeoutMs(seconds: number | undefined, fallback: number): number {
  if (seconds === undefined) return fallback;
  return Math.max(1, Math.round(seconds * 1000));
}

/** Race `promise` against a timer; rejects with a descriptive error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    timer = setTimeout(() => {
      reject(new Error(`MCP ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { if (timer) clearTimeout(timer); resolve(v); },
      (e) => { if (timer) clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Plan 580 D8 — deterministic, bounded (≤200 chars) single-line
 * metadata for a non-text MCP content block lives in
 * `./result-blocks.ts` (shared with the chain-B executor).
 */

/**
 * MCP Client - Manages connection to a single MCP server.
 * Internal to this module — only `MCPManager` is used externally.
 */
class MCPClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private config: MCPServerConfig;
  private connectionStatus: MCPConnectionStatus = 'disconnected';
  private tools: Tool[] = [];
  private circuitBreaker: CircuitBreaker;
  /** Plan 580 D2: server capabilities captured at initialize. */
  private serverCapabilities: Record<string, unknown> | undefined;
  /** Plan 580 D3: +1 on every successful transactional rediscovery commit. */
  private inventoryRevision = 0;
  /** Plan 580 D2: debounce state for tools/list_changed. */
  private listChangedTimer: ReturnType<typeof setTimeout> | undefined;
  private rediscoveryInFlight = false;
  /** Plan 580 §D6: per-connection inventory ledger (chain A instance). */
  private readonly ledger = new InventoryLedger();
  /** True while an intentional disconnect closes the transport. */
  private closing = false;
  /** Plan 580 D2: set by MCPManager; fires after a successful rediscovery. */
  private onToolsChanged: ((serverName: string) => void) | undefined;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.circuitBreaker = getCircuitBreakerManager().getBreaker(config.name);
  }

  /**
   * Get the source bucket for the runtime permission gate. Set
   * by `applyMCPConfiguration` from the resolved config; defaults
   * to `'unknown'` when the caller did not stamp the field.
   */
  getSource(): 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown' {
    return this.config.source ?? 'unknown';
  }

  /** The short, stable prefix used for model-visible tool names. */
  getNameOverride(): string | undefined {
    return this.config.nameOverride;
  }

  /** The underlying config (name + transport + timeouts). */
  getConfig(): MCPServerConfig {
    return this.config;
  }

  /**
   * Plan 580 D2: register the post-rediscovery callback. Called by
   * MCPManager (wired by apply.ts) so a list_changed notification can
   * trigger a registry replace-set without the client knowing about
   * the registry.
   */
  setOnToolsChanged(cb: ((serverName: string) => void) | undefined): void {
    this.onToolsChanged = cb;
  }

  /**
   * Apply a config update in place WITHOUT reconnecting. Only fields
   * that do not affect the transport/spawn are safe to update here;
   * everything else requires a reconnect. Currently that is the
   * three-level timeout set plus the name override.
   */
  applyConfigUpdate(next: MCPServerConfig): void {
    this.config.connectionId = next.connectionId;
    this.config.pluginId = next.pluginId;
    this.config.nameOverride = next.nameOverride;
    this.config.startupTimeoutSec = next.startupTimeoutSec;
    this.config.toolTimeoutSec = next.toolTimeoutSec;
    this.config.toolTimeouts = next.toolTimeouts;
  }

  /**
   * Return the effective startup timeout in ms for this server.
   */
  getStartupTimeoutMs(): number {
    return timeoutMs(this.config.startupTimeoutSec, DEFAULT_STARTUP_TIMEOUT_MS);
  }

  /**
   * Return the effective per-tool-call timeout in ms for `toolName`.
   * Precedence: per-tool override (`toolTimeouts`) → server default
   * (`toolTimeoutSec`) → global default.
   */
  getToolTimeoutMs(toolName: string): number {
    const perTool = this.config.toolTimeouts?.[toolName];
    return timeoutMs(perTool ?? this.config.toolTimeoutSec, DEFAULT_TOOL_TIMEOUT_MS);
  }

  /**
   * Get server name
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * Get current connection status
   */
  getStatus(): MCPConnectionStatus {
    return this.connectionStatus;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  /**
   * Get available tools
   */
  getTools(): Tool[] {
    return this.tools;
  }

  /** Plan 580 D2: server capabilities saved from `initialize`. */
  getServerCapabilities(): Record<string, unknown> | undefined {
    return this.serverCapabilities;
  }

  /** Plan 580 D3: monotonic inventory revision (per successful commit). */
  getInventoryRevision(): number {
    return this.inventoryRevision;
  }

  /** Plan 580 Phase 5: ledger snapshot for the diagnostics surface. */
  getLedgerSnapshot(): ReturnType<InventoryLedger['getSnapshot']> {
    return this.ledger.getSnapshot();
  }

  /**
   * Plan 580 D2: mark transport death. `onclose`/`onerror` are the ONLY
   * triggers — no speculative reconnect detection. Intentional
   * disconnects set `closing` first and are exempt.
   */
  private markTransportDead(reason: string): void {
    if (this.closing) return;
    if (this.connectionStatus === 'disconnected') return;
    this.connectionStatus = 'degraded';
    logger.warn(`[MCP] transport dead for "${this.config.name}": ${reason} — status=degraded`);
  }

  /**
   * Plan 580 D2: transactional rediscovery. Full paginated
   * `tools/list`; the in-memory tool set is replaced ONLY on success
   * (D6: a failed discovery never clears last-known inventory).
   */
  private async rediscoverTools(): Promise<void> {
    if (!this.client || this.connectionStatus !== 'connected') return;
    if (this.rediscoveryInFlight) return;
    this.rediscoveryInFlight = true;
    this.ledger.beginDiscovery();
    try {
      const deadline = createDeadlineClock(this.getStartupTimeoutMs());
      const debug = discoveryDebugEnabled();
      const result = await listAllTools(this.client, {
        deadline,
        generation: this.inventoryRevision + 1,
        ...(debug ? { debugLog: (m: string) => logger.info(`[MCP] ${this.config.name} ${m}`) } : {}),
      });
      this.tools = result.tools.map((t) => this.toTool(t));
      this.inventoryRevision++;
      this.ledger.commitDiscovery({
        pagesFetched: result.pagesFetched,
        discoveredTotal: result.discoveredTotal,
        truncated: result.truncated,
        ...(this.serverCapabilities ? { serverCapabilities: this.serverCapabilities } : {}),
      });
      logger.info(
        `[MCP] rediscovered tools for "${this.config.name}": ${formatDiscoveryLogLine(result)}`,
      );
      this.onToolsChanged?.(this.config.name);
    } catch (err) {
      // D6: discovery failed → keep last-known inventory, no replace.
      this.ledger.failDiscovery();
      logger.warn(
        `[MCP] rediscovery failed for "${this.config.name}"; keeping last-known inventory: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.rediscoveryInFlight = false;
    }
  }

  /**
   * Plan 580 D2: coalescing debounce for tools/list_changed. A burst
   * of notifications triggers exactly one rediscovery.
   */
  private scheduleRediscovery(): void {
    if (this.listChangedTimer) clearTimeout(this.listChangedTimer);
    this.listChangedTimer = setTimeout(() => {
      this.listChangedTimer = undefined;
      void this.rediscoverTools();
    }, LIST_CHANGED_DEBOUNCE_MS);
  }

  /** Map a Core descriptor to the agent Tool shape (annotations verbatim). */
  private toTool(tool: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }): Tool {
    // Security layer 3 (prompt injection scan): warn on suspicious tool
    // descriptions. Does not block — false positives would break legit
    // server descriptions. Warning only — the actual source-based
    // blocking gate lives in the permission system (`decideMcpSource`).
    scanMcpDescription(this.config.name, tool.name, tool.description || '');
    const rawAnnotations = tool.annotations;
    const annotations =
      rawAnnotations && typeof rawAnnotations === 'object' && !Array.isArray(rawAnnotations)
        ? (rawAnnotations as Record<string, unknown>)
        : undefined;
    return {
      name: tool.name,
      description: tool.description || '',
      input_schema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      ...(annotations ? { annotations } : {}),
    };
  }

  /**
   * Build the transport for the configured kind. Lifecycle-test seam
   * (plan 580 Phase 2.5): a subclass may override this to inject an
   * `InMemoryTransport` pair and exercise the REAL connect → notify →
   * rediscover → degrade path against a fixture server without
   * spawning a subprocess.
   */
  protected buildTransport(): Transport {
    if (this.config.transport === 'streamable-http') {
      if (!this.config.url) {
        throw new Error('Streamable HTTP MCP server requires a URL');
      }
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: this.config.headers
          ? { headers: this.config.headers }
          : undefined,
      });
    }
    if (!this.config.command) {
      throw new Error('Stdio MCP server requires a command');
    }
    // Security layer 1 (env allowlist): strip secrets from the subprocess
    // environment before spawning the MCP server process. MCP servers are
    // untrusted external code; without this, any API key / token in the
    // agent process env leaks to them. `envPassthrough: 'inherit'` opts
    // out for trusted bundled servers that depend on inherited env.
    const safeEnv = buildSafeEnv(this.config.env, {
      forceInherit: this.config.envPassthrough === 'inherit',
    });

    return new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: safeEnv,
    });
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.connectionStatus === 'connected') {
      return;
    }

    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      throw new Error(`Circuit breaker is open for MCP server: ${this.config.name}`);
    }

    try {
      this.connectionStatus = 'connecting';
      this.transport = this.buildTransport();

      // Plan 580 D2: `tools.listChanged` is a SERVER capability (the server
      // declares it will push `notifications/tools/list_changed`); the MCP
      // spec has no client-side `tools` capability and SDK 1.30.0's
      // ClientCapabilitiesSchema rejects it. Client-side subscription is the
      // setNotificationHandler(ToolListChangedNotificationSchema) below.
      this.client = new Client(
        {
          name: 'duya-mcp-client',
          version: '0.1.0',
        },
        { capabilities: {} },
      );

      // Plan 580 D2: transport death → degraded (no speculative reconnect).
      this.closing = false;
      this.transport.onclose = () => this.markTransportDead('transport closed');
      this.transport.onerror = (err) => this.markTransportDead(`transport error: ${err}`);

      const startupMs = this.getStartupTimeoutMs();
      await withTimeout(
        this.client.connect(this.transport),
        startupMs,
        `connect to "${this.config.name}"`,
      );

      // Plan 580 D2: save server capabilities from the initialize result.
      try {
        const caps = this.client.getServerCapabilities();
        if (caps && typeof caps === 'object') {
          this.serverCapabilities = caps as Record<string, unknown>;
        }
      } catch {
        // getServerCapabilities is sync and should not throw; defensive.
      }

      // Plan 580 D2: tools/list_changed → debounce → transactional rediscovery.
      this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        logger.info(`[MCP] tools/list_changed from "${this.config.name}" (debounced ${LIST_CHANGED_DEBOUNCE_MS}ms)`);
        this.scheduleRediscovery();
      });

      // Plan 580 D3: transactional paginated discovery (Phase 0
      // instrumentation: DUYA_MCP_DISCOVERY_DEBUG=1 logs every page with
      // cursor/pages/total under the SAME connection / OAuth grant).
      const startupDeadline = createDeadlineClock(startupMs);
      const debug = discoveryDebugEnabled();
      const discovery = await listAllTools(this.client, {
        deadline: startupDeadline,
        generation: this.inventoryRevision + 1,
        ...(debug ? { debugLog: (m: string) => logger.info(`[MCP] ${this.config.name} ${m}`) } : {}),
      });

      // Post-discovery generation check: nothing can supersede during a
      // connect, but keep the guard symmetric with rediscovery.
      this.tools = discovery.tools.map((t) => this.toTool(t));
      this.inventoryRevision++;
      this.ledger.commitDiscovery({
        pagesFetched: discovery.pagesFetched,
        discoveredTotal: discovery.discoveredTotal,
        truncated: discovery.truncated,
        ...(this.serverCapabilities ? { serverCapabilities: this.serverCapabilities } : {}),
      });

      this.connectionStatus = 'connected';
      this.circuitBreaker.recordSuccess();

      logger.info(
        `[MCP] Connected to server: ${this.config.name} (${formatDiscoveryLogLine(discovery)})`,
      );
    } catch (error) {
      this.connectionStatus = 'error';
      this.circuitBreaker.recordFailure();

      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[MCP] Failed to connect to server: ${this.config.name} - ${errorMsg}`);
      throw new Error(`Failed to connect to MCP server ${this.config.name}: ${errorMsg}`);
    }
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    // Intentional close — exempt from the degraded transition.
    this.closing = true;
    if (this.listChangedTimer) {
      clearTimeout(this.listChangedTimer);
      this.listChangedTimer = undefined;
    }
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.connectionStatus = 'disconnected';
    this.tools = [];
    logger.info(`[MCP] Disconnected from server: ${this.config.name}`);
  }

  /**
   * Call a tool on the MCP server
   *
   * Plan 580 D5: single deadline → SDK `{ timeout, signal }`. The SDK
   * sends a per-request cancellation on abort; we NEVER close the
   * shared transport for one aborted call (it serves parallel calls).
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const fail = (message: string, code?: string): ToolResult => ({
      id: `${this.config.name}-${name}`,
      name,
      result: code ? `[${code}] ${message}` : message,
      error: true,
    });

    if (!this.client) {
      return fail(`MCP server not connected: ${this.config.name}`, 'MCP_TRANSPORT');
    }
    // Plan 580 D2: a degraded transport fails immediately instead of
    // hanging on the SDK 60s default timeout.
    if (this.connectionStatus === 'degraded') {
      return fail(`MCP transport degraded for server: ${this.config.name}`, 'MCP_TRANSPORT');
    }
    if (this.connectionStatus !== 'connected') {
      return fail(`MCP server not connected: ${this.config.name}`, 'MCP_TRANSPORT');
    }

    // Check connection-level circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      return fail(`Circuit breaker is open for MCP server: ${this.config.name}`, 'MCP_TRANSPORT');
    }

    // Plan 580 D9: tool-scoped breaker (timeout disposition) — independent
    // counter keyed connection:tool, same parameters as the connection
    // breaker. A slow generation tool must never fuse the whole server.
    const toolScopedBreaker = getCircuitBreakerManager().getBreaker(`${this.config.name}:${name}`);
    if (!toolScopedBreaker.canExecute()) {
      return fail(
        `Circuit breaker is open for MCP tool: ${this.config.name}.${name} (repeated timeouts)`,
        'MCP_TIMEOUT',
      );
    }

    // Plan 580 D5: effective timeout = per-tool override → server default
    // → 120s global. One deadline drives both the SDK `timeout` and the
    // `signal`; no outer race timer, no transport close fallback.
    const effectiveTimeoutMs = this.getToolTimeoutMs(name);
    const deadline = createDeadlineClock(effectiveTimeoutMs);

    try {
      const result = await this.client.callTool(
        {
          name,
          arguments: args,
        },
        CallToolResultSchema,
        { timeout: deadline.remainingMs(), signal: deadline.signal },
      );

      // Success closes BOTH breakers (connection + tool-scoped).
      this.circuitBreaker.recordSuccess();
      toolScopedBreaker.recordSuccess();

      // Plan 580 D8: canonical blocks saved losslessly; model-facing text
      // = text blocks joined + bounded metadata lines for non-text blocks
      // (shared last-mile in ./result-blocks.ts).
      const content = (result.content ?? []) as Array<Record<string, unknown>>;
      const composed = composeResultFromBlocks(content);

      const toolResult: ToolResult = {
        id: `${this.config.name}-${name}`,
        name,
        result: composed.text,
        ...(composed.hasNonText ? { blocks: content as unknown[] } : {}),
        ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
      };
      if (result.isError) {
        // Plan 580 D9: a JSON-RPC-level success carrying isError=true is a
        // BUSINESS error (server's normal answer) — no breaker impact.
        toolResult.error = true;
      }
      return toolResult;
    } catch (error) {
      // Plan 580 D9: classify → disposition. Only transport/protocol
      // failures count toward the connection breaker; timeouts count
      // toward the tool-scoped breaker; auth/business are ignored.
      const { cls, disposition } = (() => {
        const c = classifyMcpError(error);
        return { cls: c, disposition: breakerDisposition(c) };
      })();
      switch (disposition) {
        case 'connection':
          this.circuitBreaker.recordFailure();
          break;
        case 'tool-scoped':
          toolScopedBreaker.recordFailure();
          break;
        case 'ignore':
          break;
      }

      const rawMsg = error instanceof Error ? error.message : String(error);
      // Security layer 2 (secret sanitization): redact credential-like
      // patterns (ghp_*, sk-*, Bearer, token=, etc.) before the error
      // message is returned to the LLM via ToolResult.result. Without
      // this, a misconfigured MCP server that echoes its auth token in
      // an error string would leak it into the conversation history.
      const errorMsg = sanitizeSecrets(rawMsg);
      const code = errorCodeForClass(cls);
      logger.error(`[MCP] Tool call failed (${cls}/${disposition}): ${this.config.name}.${name} - ${rawMsg}`);
      return {
        id: `${this.config.name}-${name}`,
        name,
        result: `[${code}] ${errorMsg}`,
        error: true,
      };
    }
  }

  /**
   * List resources exposed by this MCP server.
   *
   * Returns `[]` when:
   *  - the client is not connected
   *  - the server does not implement the resources capability (the SDK
   *    throws "Method not found")
   *  - the call times out / errors for any other reason
   *
   * Resources are MCP's read-only data plane (files, DB rows, API
   * snapshots). Some servers expose a handful; most expose none. The
   * list_mcp_resources tool surfaces this so the model can discover
   * what's available.
   */
  async listResources(): Promise<Array<{ uri: string; name?: string; description?: string; mimeType?: string }>> {
    if (!this.client || this.connectionStatus !== 'connected') {
      return [];
    }
    try {
      const result = await this.client.listResources();
      // The SDK returns `{ resources, nextCursor? }`. We only return the
      // page at hand — pagination can be added when an MCP server actually
      // returns more resources than fit in one page in practice.
      return result.resources.map((r) => ({
        uri: r.uri,
        ...(r.name !== undefined && { name: r.name }),
        ...(r.description !== undefined && { description: r.description }),
        ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
      }));
    } catch (error) {
      // Method not found = the server simply doesn't expose resources.
      // That's not an error condition for our caller; surface as empty.
      const msg = error instanceof Error ? error.message : String(error);
      if (/Method not found/i.test(msg) || /unknown method/i.test(msg)) {
        return [];
      }
      logger.warn(`[MCP] listResources failed for ${this.config.name}: ${msg}`);
      return [];
    }
  }
}

/**
 * MCP Manager - Manages multiple MCP server connections
 */
export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();
  /** Plan 580 D2: post-rediscovery callback wired by apply.ts. */
  private toolsChangedHandler: ((serverName: string) => void) | undefined;

  /**
   * Plan 580 D2: register the tools-changed callback. Applies to every
   * current AND future client of this manager.
   */
  setOnToolsChanged(cb: ((serverName: string) => void) | undefined): void {
    this.toolsChangedHandler = cb;
    for (const client of this.clients.values()) {
      client.setOnToolsChanged(cb);
    }
  }

  /**
   * Stable fingerprint of the connect-relevant fields of a config.
   * Two configs with the same signature spawn an identical transport,
   * so an existing client can be reused without reconnecting.
   */
  static configSignature(config: MCPServerConfig): string {
    return JSON.stringify({
      transport: config.transport ?? 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
      url: config.url,
      headers: config.headers,
    });
  }

  /**
   * Add and connect to an MCP server
   */
  async addServer(config: MCPServerConfig): Promise<MCPClient> {
    const client = new MCPClient(config);
    client.setOnToolsChanged(this.toolsChangedHandler);
    await client.connect();
    this.clients.set(config.name, client);
    return client;
  }

  /**
   * Adopt an existing, already-connected client into this manager
   * WITHOUT reconnecting. Applies the new config in place (currently
   * the timeout set + name override) so a hot-reload that only
   * changes timeouts does not need to respawn the server process.
   * The client is keyed by its existing name.
   */
  adopt(client: MCPClient, newConfig: MCPServerConfig): MCPClient {
    client.applyConfigUpdate(newConfig);
    client.setOnToolsChanged(this.toolsChangedHandler);
    this.clients.set(client.getName(), client);
    return client;
  }

  /**
   * Remove a client from this manager and return it WITHOUT
   * disconnecting. Used to hand a still-valid client to the next
   * generation manager during an incremental reload. Returns
   * `undefined` if `name` is not present.
   */
  extract(name: string): MCPClient | undefined {
    const client = this.clients.get(name);
    if (client) this.clients.delete(name);
    return client;
  }

  /**
   * Remove and disconnect from an MCP server
   */
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
  }

  /**
   * Get a client by name
   */
  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  /**
   * Get all connected clients
   */
  getAllClients(): MCPClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): Array<Tool & { serverName: string }> {
    const tools: Array<Tool & { serverName: string }> = [];
    for (const client of this.clients.values()) {
      if (client.isConnected()) {
        for (const tool of client.getTools()) {
          tools.push({
            ...tool,
            serverName: client.getName(),
          });
        }
      }
    }
    return tools;
  }

  /**
   * Phase 2A worker closure: same as getAllTools but with
   * Tool.internalKey / providerName / mcpInfo pre-computed for
   * direct registration. The providerName allocator is supplied
   * by the caller (applyMCPConfiguration) so lifecycle and
   * uniqueness policy stay in one place. Tools from disconnected
   * clients are skipped, matching the previous getAllTools
   * behavior.
   *
   * Tools are sorted by (scopedServerName asc, toolName asc)
   * before allocation; the allocator maintains its own usedNames
   * set, so identical input + identical ordering yields identical
   * providerNames across reloads.
   */
  getAllToolsWithIdentity(
    allocateProviderName: (internalKey: string, nameOverride?: string) => string,
  ): Array<Tool & { serverName: string }> {
    type Pending = {
      scopedServerName: string;
      toolName: string;
      description: string;
      input_schema: Record<string, unknown>;
      source: 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown';
      connectionId?: string;
      pluginId?: string;
      nameOverride?: string;
    };
    const pending: Pending[] = [];
    for (const client of this.clients.values()) {
      if (!client.isConnected()) continue;
      const scopedServerName = client.getName();
      const source = client.getSource();
      const config = client.getConfig();
      const nameOverride = client.getNameOverride();
      for (const tool of client.getTools()) {
        pending.push({
          scopedServerName,
          toolName: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
          source,
          connectionId: config.connectionId,
          pluginId: config.pluginId,
          nameOverride,
        });
      }
    }
    pending.sort((a, b) => {
      if (a.scopedServerName < b.scopedServerName) return -1;
      if (a.scopedServerName > b.scopedServerName) return 1;
      if (a.toolName < b.toolName) return -1;
      if (a.toolName > b.toolName) return 1;
      return 0;
    });
    const tools: Array<Tool & { serverName: string }> = [];
    for (const p of pending) {
      const internalKey = `mcp__${p.scopedServerName}__${p.toolName}`;
      const providerName = allocateProviderName(internalKey, p.nameOverride);
      tools.push({
        name: providerName,
        description: p.description,
        input_schema: p.input_schema,
        internalKey,
        providerName,
        mcpInfo: {
          serverName: p.scopedServerName,
          toolName: p.toolName,
          source: p.source,
          connectionId: p.connectionId,
          pluginId: p.pluginId,
        },
        serverName: p.scopedServerName,
      });
    }
    return tools;
  }

  /**
   * Call a tool on a specific server
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    return client.callTool(toolName, args);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }

  /**
   * Get connection status for all servers
   */
  getAllStatus(): Array<{ name: string; status: MCPConnectionStatus; toolCount: number }> {
    return Array.from(this.clients.entries()).map(([name, client]) => ({
      name,
      status: client.getStatus(),
      toolCount: client.getTools().length,
    }));
  }
}

export { MCPClient };

// Plan 580 D9: McpError re-exported for consumers translating errors.
export { McpError };
