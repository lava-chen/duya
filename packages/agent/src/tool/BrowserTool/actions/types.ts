import type { z } from 'zod/v4';
import type { ToolResult } from '../../../types.js';
import type { ICDPClient } from '../CDPClient.js';
import type { SnapshotEngine } from '../SnapshotEngine.js';
import type { FallbackBrowser } from '../FallbackBrowser.js';
import type { BrowserBackendMode, BrowserMode } from '../types.js';
import type { PlatformContent, ExtractionOptions } from '../platform-extractors/types.js';

export interface ActionContext {
  cdp: ICDPClient | null;
  snapshotEngine: SnapshotEngine | null;
  fallbackBrowser: FallbackBrowser | null;
  mode: BrowserMode;
  browserBackendMode: BrowserBackendMode;
  extensionAvailable: boolean;
  platformHookManager: {
    shouldApplyHooks(url: string): boolean;
    applyPostNavigateHooks(cdp: ICDPClient, url: string): Promise<void>;
    hasExtractor(url: string): boolean;
    extractContent(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent | null>;
  };
  checkDomainBlocked(url: string): boolean;
  getBrowserPool(): import('../BrowserPool.js').BrowserPool;
  /** Stable identifier for the current agent turn — used to scope screenshot files. */
  sessionId?: string;
}

export interface ActionHandler<TInput = Record<string, unknown>> {
  readonly operation: string;
  readonly schema: z.ZodType<TInput>;
  execute(input: TInput, ctx: ActionContext): Promise<Record<string, unknown>>;
}

export type ActionResult = ToolResult;
