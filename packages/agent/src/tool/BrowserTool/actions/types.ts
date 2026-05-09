import type { z } from 'zod/v4';
import type { ToolResult } from '../../../types.js';
import type { ICDPClient } from '../CDPClient.js';
import type { SnapshotEngine } from '../SnapshotEngine.js';
import type { FallbackBrowser } from '../FallbackBrowser.js';
import type { BrowserMode } from '../types.js';

export interface ActionContext {
  cdp: ICDPClient | null;
  snapshotEngine: SnapshotEngine | null;
  fallbackBrowser: FallbackBrowser | null;
  mode: BrowserMode;
  extensionAvailable: boolean;
  platformHookManager: {
    shouldApplyHooks(url: string): boolean;
    applyPostNavigateHooks(cdp: ICDPClient, url: string): Promise<void>;
  };
  checkDomainBlocked(url: string): boolean;
  getBrowserPool(): import('../BrowserPool.js').BrowserPool;
}

export interface ActionHandler<TInput = Record<string, unknown>> {
  readonly operation: string;
  readonly schema: z.ZodType<TInput>;
  execute(input: TInput, ctx: ActionContext): Promise<Record<string, unknown>>;
}

export type ActionResult = ToolResult;
