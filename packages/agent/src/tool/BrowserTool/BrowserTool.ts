/**
 * BrowserTool - DUYA Agent Browser Tool (Refactored)
 * Slim facade using ActionRegistry pattern.
 * Supports: 23 operations via pluggable action handlers.
 * Three backends: Extension CDP, Playwright, Fallback (static).
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { BaseTool } from '../BaseTool.js';
import { BROWSER_TOOL_NAME, BROWSER_TOOL_DESCRIPTION } from './constants.js';
import { ExtensionCDPClient, type ICDPClient } from './CDPClient.js';
import { WebviewCDPClient } from './WebviewCDPClient.js';
import { resolveBackend, DEFAULT_BROWSER_CONFIG, type BrowserToolConfig } from './backend-resolver.js';
import { SnapshotEngine } from './SnapshotEngine.js';
import { FallbackBrowser } from './FallbackBrowser.js';
import { ParallelFetcher } from './ParallelFetcher.js';
import { BrowserPool } from './BrowserPool.js';
import { getPrompt } from './prompt.js';
import { PlatformHookManager } from './platform-hooks/PlatformHookManager.js';
import { isUrlBlocked, getEffectiveBlockedDomains, type DomainBlockerConfig } from './DomainBlocker.js';
import { ActionRegistry, SchemaGenerator, getAllActions, type ActionContext } from './actions/index.js';
import { formatResult } from './ResultFormatter.js';
import type { BrowserMode, NetworkEnvironment } from './types.js';

export class BrowserTool extends BaseTool implements Tool, ToolExecutor {
  readonly name = BROWSER_TOOL_NAME;
  readonly description = BROWSER_TOOL_DESCRIPTION;

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
    if (this.cdp) {
      this.cdp.close?.().catch(() => {});
      this.cdp = null;
    }
    this.fallbackBrowser = null;
    this.snapshotEngine = null;
    this.mode = 'fallback';
    this.extensionAvailable = false;
  }

  private ensureConnection = async (): Promise<void> => {
    if (this.cdp || this.fallbackBrowser) return;

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const config = this.config ?? DEFAULT_BROWSER_CONFIG;

    // Probe extension health (with timeout). Skipped entirely in built-in mode.
    const extensionClient = new ExtensionCDPClient(sessionId);
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
        const webviewClient = new WebviewCDPClient(sessionId);
        await webviewClient.connect();
        this.cdp = webviewClient;
        this.snapshotEngine = new SnapshotEngine(webviewClient);
        this.mode = 'webview';
        this.extensionAvailable = false;
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
      extensionAvailable: this.extensionAvailable,
      platformHookManager: this.platformHookManager,
      checkDomainBlocked: (url: string) =>
        isUrlBlocked(url, getEffectiveBlockedDomains(this.domainBlockerConfig)),
      getBrowserPool: () => {
        if (!this.browserPool) this.browserPool = new BrowserPool();
        return this.browserPool;
      },
      sessionId,
    };
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const operation = input['operation'] as string;
    console.log('[BrowserTool.execute] operation:', operation);

    if (!operation) {
      return { id: crypto.randomUUID(), name: this.name, result: JSON.stringify({ error: 'Missing operation' }), error: true };
    }

    try {
      await this.ensureConnection();
      const ctx = this.buildContext(context?.options?.sessionId);
      console.log('[BrowserTool.execute] built context, about to execute:', operation);
      const result = await this.actionRegistry.execute(operation, input, ctx);

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: formatResult(operation, { operation, mode: this.mode, ...result }),
      };
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
    if (this.cdp) {
      await this.cdp.close();
      this.cdp = null;
      this.snapshotEngine = null;
    }
    if (this.browserPool) {
      await this.browserPool.shutdown();
      this.browserPool = null;
    }
    this.fallbackBrowser = null;
  }

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  getPrompt(): string {
    return getPrompt(this.networkEnvironment);
  }
}

export const browserTool = new BrowserTool();
export default BrowserTool;

export type BrowserInput = Record<string, unknown>;
