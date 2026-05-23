import { z } from 'zod/v4';
import type { ActionHandler } from './types.js';

// ─── parallel_fetch ───────────────────────────────────────

const parallelFetchSchema = z.object({
  urls: z.preprocess(
    (val) => {
      // LLM may pass a stringified JSON array, normalize to string[]
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val);
          return Array.isArray(parsed) ? (parsed as string[]) : [val as string];
        } catch {
          return [val as string];
        }
      }
      return val;
    },
    z.array(z.string())
  ).describe('REQUIRED. Array of URLs to investigate in parallel. Example: ["https://site1.com", "https://site2.com"]'),
  useBrowser: z.boolean().optional().default(true).describe('Use real browser (Extension CDP / Duya browser plugin) for JS-rendered snapshots. Default: true. Set to false to use fast HTTP fetch (no JS rendering).'),
  task: z.string().optional().describe('Optional task description for context-aware investigation'),
  evaluate: z.string().optional().describe('Optional JavaScript to execute on each page after load (only when useBrowser=true)'),
  timeoutMs: z.number().optional().default(30000).describe('Per-page timeout in milliseconds (default 30000)'),
});

export const parallelFetchAction: ActionHandler<z.infer<typeof parallelFetchSchema>> = {
  operation: 'parallel_fetch',
  schema: parallelFetchSchema,
  async execute(data, _ctx) {
    if (data.useBrowser) {
      // Use BrowserPool → Extension CDP (preferred) or Playwright fallback
      const { BrowserPool } = await import('../BrowserPool.js');
      const pool = new BrowserPool();

      const tasks = data.urls.map((url, index) => ({
        id: `invest_${index}`,
        url,
        task: data.task,
        evaluate: data.evaluate,
      }));

      const results = await pool.investigate(tasks, data.timeoutMs ?? 30000);
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
    }

    // Default: fast static HTTP fetch (axios)
    const { ParallelFetcher } = await import('../ParallelFetcher.js');
    const fetcher = new ParallelFetcher();

    const tasks = data.urls.map((url, index) => ({
      id: `task_${index}`,
      url,
      extract: 'text' as const,
    }));
    const results = await fetcher.fetchBatch(tasks);

    return {
      results: results.map(r => ({
        url: r.url,
        success: r.success,
        title: r.title,
        content: r.content,
        interactiveCount: r.interactiveCount,
        error: r.error,
        durationMs: r.durationMs,
      })),
      total: results.length,
      successful: results.filter(r => r.success).length,
      mode: 'parallel_fetch',
    };
  },
};