/**
 * BrowserTool - DUYA Agent Browser Tool (Refactored)
 * Slim facade using ActionRegistry pattern.
 * Supports: 23 operations via pluggable action handlers.
 * Three backends: Extension CDP, Playwright, Fallback (static).
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { BaseTool } from '../BaseTool.js';
import { BROWSER_TOOL_NAME, BROWSER_TOOL_DESCRIPTION, BROWSER_TOOL_DESCRIPTION_HUMAN_LIKE } from './constants.js';
import { ExtensionCDPClient, clearBrowserCache, type ICDPClient } from './CDPClient.js';
import { WebviewCDPClient } from './WebviewCDPClient.js';
import { HumanLikeCDPClient } from './HumanLikeCDPClient.js';
import { resolveBackend, DEFAULT_BROWSER_CONFIG, type BrowserToolConfig } from './backend-resolver.js';
import { SnapshotEngine } from './SnapshotEngine.js';
import { FallbackBrowser } from './FallbackBrowser.js';
import { ParallelFetcher } from './ParallelFetcher.js';
import { BrowserPool } from './BrowserPool.js';
import { getPrompt } from './prompt.js';
import { detectNetworkEnvironment } from './networkEnv.js';
import { PlatformHookManager } from './platform-hooks/PlatformHookManager.js';
import { isUrlBlocked, getEffectiveBlockedDomains, type DomainBlockerConfig } from './DomainBlocker.js';
import { ActionRegistry, SchemaGenerator, getAllActions, type ActionContext } from './actions/index.js';
import { formatResult } from './ResultFormatter.js';
import { isRecoverableSessionInvalidation, retryOnceAfterSessionInvalidation } from './selfHealing.js';
import type { BrowserMode, NetworkEnvironment } from './types.js';
import { logger } from '../../utils/logger.js';

/** Close idle agent pages (and clear cache) this long after the last browser operation. */
const BROWSER_IDLE_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;

export class BrowserTool extends BaseTool implements Tool, ToolExecutor {
  readonly name = BROWSER_TOOL_NAME;
  get description(): string {
    // When human-like mode is active, surface the computer-use capability
    // prominently so the LLM knows coordinate-driven actions are preferred.
    if (this.config?.mode === 'human-like') {
      return BROWSER_TOOL_DESCRIPTION_HUMAN_LIKE;
    }
    return BROWSER_TOOL_DESCRIPTION;
  }

  private readonly actionRegistry = new ActionRegistry();
  readonly input_schema: Record<string, unknown>;

  private cdp: ICDPClient | null = null;
  private snapshotEngine: SnapshotEngine | null = null;
  private fallbackBrowser: FallbackBrowser | null = null;
  private parallelFetcher = new ParallelFetcher();
  private platformHookManager = new PlatformHookManager();
  private browserPool: BrowserPool | null = null;
  private mode: BrowserMode = 'extension';
  private extensionAvailable = false;
  private domainBlockerConfig: DomainBlockerConfig | undefined;
  private networkEnvironment: NetworkEnvironment | undefined;
  private config: BrowserToolConfig | null = null;
  private currentSessionId: string | null = null;

  /** In-flight connection attempt — collapses concurrent ensureConnection calls into one. */
  private connectionPromise: Promise<void> | null = null;
  /** Number of currently executing browser operations (concurrency detector). */
  private inflightOps = 0;
  /** Monotonic counter for ephemeral per-operation session ids. */
  private ephemeralSeq = 0;
  /** Timer that auto-closes idle pages after the last operation finishes. */
  private idleCloseTimer: NodeJS.Timeout | null = null;

  constructor(domainBlockerConfig?: DomainBlockerConfig) {
    super();
    this.domainBlockerConfig = domainBlockerConfig;

    // Register all action handlers
    const actions = getAllActions();
    this.actionRegistry.registerAll(actions);

    // Auto-generate JSON Schema from action definitions (single source of truth)
    const { inputSchema } = SchemaGenerator.generate(actions);
    this.input_schema = inputSchema;
  }

  setDomainBlockerConfig(config: DomainBlockerConfig): void {
    this.domainBlockerConfig = config;
  }

  setNetworkEnvironment(env: NetworkEnvironment): void {
    this.networkEnvironment = env;
  }

  getNetworkEnvironment(): NetworkEnvironment | undefined {
    return this.networkEnvironment;
  }

  setBrowserConfig(config: BrowserToolConfig): void {
    const modeChanged = this.config?.mode !== config.mode;
    this.config = config;
    // If the mode changed, reset any existing connection so ensureConnection
    // re-evaluates the backend on the next tool call. Without this, a running
    // session that already connected via extension would keep using it even
    // after the user switched to built-in mode.
    if (modeChanged) {
      this.resetConnection();
    }
  }

  /**
   * Tear down the current CDP/fallback connection so the next
   * ensureConnection() re-evaluates the backend mode.
   */
  resetConnection(): void {
    this.cancelIdleCloseTimer();
    if (this.cdp) {
      this.cdp.close?.().catch(() => {});
      this.cdp = null;
    }
    this.fallbackBrowser = null;
    this.snapshotEngine = null;
    this.mode = 'fallback';
    this.extensionAvailable = false;
    this.currentSessionId = null;
  }

  /**
   * Create a short-lived dedicated client for a contending operation so it
   * drives its own page instead of interleaving CDP traffic with a
   * concurrently running operation on the shared primary client. Returns
   * null when isolation cannot be established (caller then shares the page).
   */
  private async acquireIsolatedClient(): Promise<{ client: ICDPClient; snapshotEngine: SnapshotEngine } | null> {
    if (!this.currentSessionId) return null;
    const opSessionId = `${this.currentSessionId}::op${++this.ephemeralSeq}`;
    try {
      let client: ICDPClient;
      if (this.extensionAvailable) {
        // Extension backend creates one automation tab per sessionId.
        client = new ExtensionCDPClient(opSessionId);
      } else {
        // Built-in webview (incl. human-like wrapping): background tabs keep
        // parallel investigation pages from stealing the sidebar focus.
        client = new WebviewCDPClient(opSessionId, { background: true });
      }
      await client.connect();
      logger.info(
        `[BrowserTool] Concurrent operation isolated on dedicated page (${opSessionId})`,
        undefined,
        'BrowserTool'
      );
      return { client, snapshotEngine: new SnapshotEngine(client) };
    } catch (error) {
      logger.warn(
        `[BrowserTool] Could not open an isolated page for a concurrent operation; sharing the primary page (${error instanceof Error ? error.message : error})`,
        undefined,
        'BrowserTool'
      );
      return null;
    }
  }

  /** Close an ephemeral per-operation page right after its action finished. */
  private async releaseIsolatedClient(handle: { client: ICDPClient } | null): Promise<void> {
    if (!handle) return;
    try {
      await handle.client.close();
    } catch {
      // Best effort — daemon/renderer may already have torn the tab down.
    }
  }

  /** Auto-close idle agent pages + clear cache after the last operation ends. */
  private scheduleIdleClose(): void {
    this.cancelIdleCloseTimer();
    if (this.inflightOps > 0 || (!this.cdp && !this.browserPool)) return;
    this.idleCloseTimer = setTimeout(() => {
      void this.closeIdlePages();
    }, BROWSER_IDLE_CLOSE_TIMEOUT_MS);
    // Never hold the agent process open just for the idle close.
    this.idleCloseTimer.unref?.();
  }

  private cancelIdleCloseTimer(): void {
    if (this.idleCloseTimer) {
      clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = null;
    }
  }

  private async closeIdlePages(): Promise<void> {
    this.idleCloseTimer = null;
    if (this.inflightOps > 0) return;
    logger.info(
      '[BrowserTool] Browser idle — clearing cache and closing agent pages',
      undefined,
      'BrowserTool'
    );
    await this.cleanup();
  }

  /**
   * Single-flight wrapper around connectLocked: concurrent first calls share
   * one connection attempt instead of each creating their own primary client
   * (which would leak a duplicate webview/extension tab).
   */
  private ensureConnection = (sessionId?: string): Promise<void> => {
    if (!this.connectionPromise) {
      this.connectionPromise = this.connectLocked(sessionId).finally(() => {
        this.connectionPromise = null;
      });
    }
    return this.connectionPromise;
  };

  private connectLocked = async (sessionId?: string): Promise<void> => {
    const resolvedSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (!sessionId) {
      // A caller that reaches the browser tool without `context.options.sessionId`
      // gets a brand-new id on every call. Downstream that means a new agent
      // session: the extension opens a new tab and mints a new Chrome tab
      // group per page, so the leak is worth a WARN rather than silence.
      logger.warn(
        `[BrowserTool] no sessionId in the tool context — minting ephemeral browser session (${resolvedSessionId}); agent pages will not be grouped with the owning session`,
        undefined,
        'BrowserTool'
      );
    }

    // If the session has changed, tear down the existing connection so the
    // next command targets the correct webview / extension tab.
    if (this.currentSessionId !== null && this.currentSessionId !== resolvedSessionId) {
      this.resetConnection();
    }

    if (this.cdp || this.fallbackBrowser) return;

    this.currentSessionId = resolvedSessionId;
    const config = this.config ?? DEFAULT_BROWSER_CONFIG;

    // Kick off the network-environment probe once (fire-and-forget, cached
    // process-wide). The result feeds the `search` engine chain and the
    // prompt's engine guidance; never block the browser connection on it.
    if (this.networkEnvironment === undefined) {
      detectNetworkEnvironment()
        .then(env => this.setNetworkEnvironment(env))
        .catch(() => {});
    }

    // Probe extension health (with timeout). Skipped entirely in built-in mode.
    // human-like mode probes too: when the extension is online it wraps the
    // user's real Chrome with human-like input instead of the sidebar webview.
    const extensionClient = new ExtensionCDPClient(resolvedSessionId);
    let extensionOnline = false;
    if (config.mode !== 'built-in') {
      try {
        const health = await Promise.race([
          extensionClient.health(),
          new Promise<{ status: string }>(resolve =>
            setTimeout(() => resolve({ status: 'timeout' }), config.extensionProbeTimeoutMs),
          ),
        ]);
        extensionOnline = health.status === 'ok';
      } catch {
        extensionOnline = false;
      }
    }

    // Renderer availability is determined by whether we're in a headless agent
    // process running inside Electron. When the daemon is reachable, a webview
    // can be driven via webContents.debugger CDP.
    const rendererAvailable = !!process.env.DUYA_DAEMON_PORT;

    const backend = resolveBackend(config.mode, extensionOnline, rendererAvailable);

    switch (backend) {
      case 'extension': {
        await extensionClient.connect();
        this.cdp = extensionClient;
        this.snapshotEngine = new SnapshotEngine(extensionClient);
        this.mode = 'extension';
        this.extensionAvailable = true;
        return;
      }
      case 'webview': {
        const webviewClient = new WebviewCDPClient(resolvedSessionId);
        await webviewClient.connect();
        this.cdp = webviewClient;
        this.snapshotEngine = new SnapshotEngine(webviewClient);
        this.mode = 'webview';
        this.extensionAvailable = false;
        return;
      }
      case 'human-like': {
        // Prefer the extension when online so human-like input drives the
        // user's real logged-in Chrome; otherwise wrap the sidebar webview.
        const base = extensionOnline ? extensionClient : new WebviewCDPClient(resolvedSessionId);
        const humanLikeClient = new HumanLikeCDPClient({
          base,
          mode: 'human-like',
        });
        await humanLikeClient.connect();
        this.cdp = humanLikeClient;
        this.snapshotEngine = new SnapshotEngine(base);
        this.mode = 'human-like';
        this.extensionAvailable = extensionOnline;
        return;
      }
      case 'fallback':
      default: {
        this.fallbackBrowser = new FallbackBrowser();
        this.mode = 'fallback';
        this.extensionAvailable = false;
        return;
      }
    }
  };

  private buildContext(sessionId?: string): ActionContext {
    return {
      cdp: this.cdp,
      snapshotEngine: this.snapshotEngine,
      fallbackBrowser: this.fallbackBrowser,
      mode: this.mode,
      browserBackendMode: this.config?.mode ?? 'auto',
      extensionAvailable: this.extensionAvailable,
      networkEnvironment: this.networkEnvironment,
      setNetworkEnvironment: (env) => this.setNetworkEnvironment(env),
      platformHookManager: this.platformHookManager,
      checkDomainBlocked: (url: string) =>
        isUrlBlocked(url, getEffectiveBlockedDomains(this.domainBlockerConfig)),
      getBrowserPool: () => {
        if (!this.browserPool) this.browserPool = new BrowserPool(this.config?.mode ?? 'auto');
        return this.browserPool;
      },
      sessionId,
    };
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const operation = input['operation'] as string;

    if (!operation) {
      return { id: crypto.randomUUID(), name: this.name, result: JSON.stringify({ error: 'Missing operation' }), error: true };
    }

    try {
      const sessionId = context?.options?.sessionId;
      // A new operation cancels any pending idle auto-close.
      this.cancelIdleCloseTimer();
      await this.ensureConnection(sessionId);

      // Concurrency detector: when another browser operation is still in
      // flight, run this one on an ephemeral dedicated client (its own page)
      // so parallel actions never interleave navigations/evaluations on the
      // shared primary page. Decision + increment must stay synchronous.
      const needIsolation = this.inflightOps > 0 && this.cdp !== null && this.mode !== 'fallback';
      this.inflightOps++;
      let isolated = needIsolation ? await this.acquireIsolatedClient() : null;

      try {
        // Rebuild a fresh ActionContext on every attempt so a self-heal rebuild
        // (which swaps `this.cdp`) is reflected in the retry.
        const runOnce = () => {
          const baseCtx = this.buildContext(sessionId);
          const ctx: ActionContext = isolated
            ? { ...baseCtx, cdp: isolated.client, snapshotEngine: isolated.snapshotEngine }
            : baseCtx;
          return this.actionRegistry.execute(operation, input, ctx);
        };

        const result = await retryOnceAfterSessionInvalidation(runOnce, {
          isRecoverable: isRecoverableSessionInvalidation,
          rebuild: async () => {
            logger.warn(
              `[BrowserTool] Session handle invalidated for operation "${operation}"; rebuilding browser session and retrying once.`,
              undefined,
              'BrowserTool'
            );
            if (isolated) {
              await this.releaseIsolatedClient(isolated);
              isolated = null;
            }
            this.resetConnection();
            await this.ensureConnection(sessionId);
          },
          alwaysSurfaceFailureMessage: true,
        });

        const resultPayload = { operation, mode: this.mode, ...result };

        // For parallel_fetch and search, preserve a structured result list so
        // the UI can render a search-result card without parsing markdown.
        const metadata: ToolResult['metadata'] | undefined =
          (operation === 'parallel_fetch' || operation === 'search') && Array.isArray(result.results)
            ? {
                browserResults: result.results.map((item: Record<string, unknown>) => ({
                  url: String(item.url ?? ''),
                  title: typeof item.title === 'string' && item.title ? item.title : undefined,
                  // parallel_fetch items carry an explicit success flag; search
                  // items have none (any returned item is a live result), so
                  // treat anything that is not explicitly `false` as success.
                  success: item.success !== false,
                  error: typeof item.error === 'string' ? item.error : undefined,
                })),
              }
            : undefined;

        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: formatResult(operation, resultPayload),
          metadata,
        };
      } finally {
        this.inflightOps--;
        if (isolated) {
          await this.releaseIsolatedClient(isolated);
        }
        this.scheduleIdleClose();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: errorMessage, mode: this.mode, operation }),
        error: true,
      };
    }
  }

  async cleanup(): Promise<void> {
    this.cancelIdleCloseTimer();
    if (this.cdp) {
      // Clear the HTTP cache before tearing the page down so credentials /
      // tracked resources from automated browsing do not linger.
      await clearBrowserCache(this.cdp);
      try {
        await this.cdp.close();
      } catch {
        // Best effort — client may already be gone.
      }
      this.cdp = null;
      this.snapshotEngine = null;
    }
    if (this.browserPool) {
      await this.browserPool.shutdown();
      this.browserPool = null;
    }
    this.fallbackBrowser = null;
    this.currentSessionId = null;
    this.extensionAvailable = false;
  }

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  getPrompt(): string {
    return getPrompt(this.networkEnvironment, this.config?.mode);
  }
}

export const browserTool = new BrowserTool();
export default BrowserTool;

export type BrowserInput = Record<string, unknown>;
