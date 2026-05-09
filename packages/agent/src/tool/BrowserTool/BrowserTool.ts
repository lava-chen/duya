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
import { createCDPClient, type ICDPClient } from './CDPClient.js';
import { SnapshotEngine } from './SnapshotEngine.js';
import { FallbackBrowser } from './FallbackBrowser.js';
import { ParallelFetcher } from './ParallelFetcher.js';
import { BrowserPool } from './BrowserPool.js';
import { getPrompt } from './prompt.js';
import { PlatformHookManager } from './platform-hooks/PlatformHookManager.js';
import { isUrlBlocked, getEffectiveBlockedDomains, type DomainBlockerConfig } from './DomainBlocker.js';
import { ActionRegistry, SchemaGenerator, getAllActions, type ActionContext } from './actions/index.js';
import type { BrowserMode } from './types.js';

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

  private ensureConnection = async (): Promise<void> => {
    if (this.cdp || this.fallbackBrowser) return;

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      const cdp = await createCDPClient(sessionId);
      const health = await cdp.health();
      if (health.status === 'ok') {
        this.cdp = cdp;
        this.snapshotEngine = new SnapshotEngine(cdp);
        this.mode = health.mode === 'extension' ? 'extension' : 'playwright';
        this.extensionAvailable = health.mode === 'extension';
        return;
      }
    } catch (error) {
      console.warn('[BrowserTool] Extension/Playwright mode failed:',
        error instanceof Error ? error.message : error);
    }

    this.fallbackBrowser = new FallbackBrowser();
    this.mode = 'fallback';
  };

  private buildContext(): ActionContext {
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
    };
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const operation = input['operation'] as string;
    if (!operation) {
      return { id: crypto.randomUUID(), name: this.name, result: JSON.stringify({ error: 'Missing operation' }), error: true };
    }

    try {
      await this.ensureConnection();
      const ctx = this.buildContext();
      const result = await this.actionRegistry.execute(operation, input, ctx);

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ operation, mode: this.mode, ...result }),
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
    return getPrompt();
  }
}

export const browserTool = new BrowserTool();
export default BrowserTool;

export type BrowserInput = Record<string, unknown>;
