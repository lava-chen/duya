import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';
import type { InvestigationTask } from '../BrowserPool.js';

// ─── parallel_fetch ───────────────────────────────────────

const parallelFetchSchema = z.object({
  urls: z.array(z.string()).describe('URLs to fetch in parallel (static HTTP, no browser)'),
  selector: z.string().optional().describe('CSS selector to extract from each page'),
});

export const parallelFetchAction: ActionHandler<z.infer<typeof parallelFetchSchema>> = {
  operation: 'parallel_fetch',
  schema: parallelFetchSchema,
  async execute(data, ctx) {
    // parallel_fetch uses static ParallelFetcher (axios), needs direct access
    // We import lazily to avoid circular deps
    const { ParallelFetcher } = await import('../ParallelFetcher.js');
    const fetcher = new ParallelFetcher();

    const tasks = data.urls.map((url, index) => ({
      id: `task_${index}`,
      url,
      selector: data.selector,
      extract: 'text' as const,
    }));
    const results = await fetcher.fetchBatch(tasks);

    return {
      results: results.map(r => ({
        url: r.url,
        success: r.success,
        title: r.title,
        content: r.content,
        error: r.error,
        durationMs: r.durationMs,
      })),
      total: results.length,
      successful: results.filter(r => r.success).length,
      mode: 'parallel_fetch',
    };
  },
};

// ─── browser_parallel ─────────────────────────────────────

const browserParallelSchema = z.object({
  urls: z.array(z.string()).describe('REQUIRED. Array of URLs to investigate in parallel with real browsers. Example: ["https://site1.com", "https://site2.com"]'),
  task: z.string().optional().describe('Optional task description for context-aware investigation'),
  evaluate: z.string().optional().describe('Optional JavaScript to execute on each page after load'),
  timeoutMs: z.number().optional().default(30000).describe('Optional per-page timeout in milliseconds (default 30000)'),
});

export const browserParallelAction: ActionHandler<z.infer<typeof browserParallelSchema>> = {
  operation: 'browser_parallel',
  schema: browserParallelSchema,
  async execute(data, ctx) {
    const pool = ctx.getBrowserPool();

    // Defensive: normalize urls to array (LLM may pass a stringified array)
    let urls: string[] = data.urls;
    if (typeof urls === 'string') {
      const urlStr = urls;
      try {
        const parsed = JSON.parse(urlStr);
        urls = Array.isArray(parsed) ? (parsed as string[]) : [urlStr];
      } catch {
        urls = [urlStr];
      }
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error('urls must be a non-empty array of strings');
    }

    const tasks: InvestigationTask[] = urls.map((url, index) => ({
      id: `invest_${index}`,
      url,
      task: data.task,
      evaluate: data.evaluate,
    }));

    const results = await pool.investigate(tasks, data.timeoutMs);
    const stats = pool.getStats();

    return {
      results: results.map(r => ({
        id: r.id,
        url: r.url,
        title: r.title,
        snapshot: r.snapshot,
        interactiveElements: r.interactiveElements,
        evaluateResult: r.evaluateResult,
        success: r.success,
        error: r.error,
        durationMs: r.durationMs,
      })),
      total: results.length,
      successful: results.filter(r => r.success).length,
      poolStats: stats,
      mode: 'browser_pool',
    };
  },
};
