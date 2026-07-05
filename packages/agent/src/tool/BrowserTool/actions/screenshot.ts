import { z } from 'zod/v4';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionHandler, ActionContext } from './types.js';

const screenshotSchema = z.object({
  fullPage: z.preprocess(
    (val) => {
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return val;
    },
    z.boolean().optional().default(false)
  ).describe('Capture full page'),
  selector: z.string().optional().describe('CSS selector for element screenshot'),
});

function buildScreenshotDir(sessionId?: string): string {
  const safeSession = sessionId?.replace(/[^A-Za-z0-9_.-]/g, '_') || 'uncategorized';
  return join(tmpdir(), 'duya-browser-screenshots', safeSession);
}

export const screenshotAction: ActionHandler<z.infer<typeof screenshotSchema>> = {
  operation: 'screenshot',
  schema: screenshotSchema,
  async execute(data, ctx: ActionContext) {
    if (!ctx.cdp) {
      return { error: 'Screenshots not available in fallback mode', mode: ctx.mode };
    }

    const base64 = await ctx.cdp.screenshot({
      fullPage: data.fullPage,
      selector: data.selector,
    });

    const dir = buildScreenshotDir(ctx.sessionId);
    await mkdir(dir, { recursive: true });
    const fileName = `screenshot-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
    const filePath = join(dir, fileName);
    await writeFile(filePath, Buffer.from(base64, 'base64'));

    return {
      filePath,
      fullPage: data.fullPage ?? false,
      selector: data.selector,
      mode: ctx.mode,
    };
  },
};
