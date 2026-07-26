import { z } from 'zod/v4';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionHandler, ActionContext } from './types.js';

const screenshotSchema = z.object({
  fullPage: z.boolean().optional().default(false).describe('Capture full page'),
  selector: z.string().optional().describe('CSS selector for element screenshot'),
  annotate: z.boolean().optional().default(false).describe(
    'Set-of-Mark mode: overlay numbered boxes on all interactive elements (snapshot refs) before capturing. The result includes a marks table mapping each ref to its center viewport coordinates, which can be passed directly to click_at / drag.'
  ),
});

interface Mark {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const OVERLAY_ID = '__duya_som_overlay';

const INJECT_MARKS_JS = `(() => {
  const old = document.getElementById('${OVERLAY_ID}');
  if (old) old.remove();
  const marks = [];
  const overlay = document.createElement('div');
  overlay.id = '${OVERLAY_ID}';
  overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const els = document.querySelectorAll('[data-duya-ref]');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
    const ref = el.getAttribute('data-duya-ref');
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border:2px solid rgba(230,40,40,0.85);box-sizing:border-box;';
    const tag = document.createElement('div');
    tag.textContent = ref;
    tag.style.cssText = 'position:absolute;left:-2px;top:-16px;background:rgba(230,40,40,0.95);color:#fff;font:11px/13px monospace;padding:0 3px;border-radius:2px;';
    box.appendChild(tag);
    overlay.appendChild(box);
    marks.push({ ref, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
  }
  document.documentElement.appendChild(overlay);
  return marks;
})()`;

const REMOVE_MARKS_JS = `(() => {
  const el = document.getElementById('${OVERLAY_ID}');
  if (el) el.remove();
  return true;
})()`;

const VIEWPORT_JS = `(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: window.devicePixelRatio || 1,
  scrollX: Math.round(window.scrollX),
  scrollY: Math.round(window.scrollY),
}))()`;

export const screenshotAction: ActionHandler<z.infer<typeof screenshotSchema>> = {
  operation: 'screenshot',
  schema: screenshotSchema,
  async execute(data, ctx: ActionContext) {
    if (!ctx.cdp) {
      return { error: 'Screenshots not available in fallback mode', mode: ctx.mode };
    }

    let marks: Mark[] | null = null;
    let viewport: Record<string, unknown> | null = null;

    if (data.annotate) {
      try {
        marks = (await ctx.cdp.evaluate(INJECT_MARKS_JS)) as Mark[];
        viewport = (await ctx.cdp.evaluate(VIEWPORT_JS)) as Record<string, unknown>;
      } catch {
        marks = null;
      }
    }

    const base64 = await ctx.cdp.screenshot({
      fullPage: data.fullPage,
      selector: data.selector,
    });

    if (data.annotate) {
      try {
        await ctx.cdp.evaluate(REMOVE_MARKS_JS);
      } catch { /* overlay is pointer-events:none and harmless if removal fails */ }
    }

    // Persist the PNG to a temp file so the vision loop can pass a short
    // filePath to vision_analyze instead of burning tokens on an inline
    // base64 data URL. Falls back to the inline URL if the write fails.
    let filePath: string | undefined;
    try {
      const dir = join(tmpdir(), 'duya-screenshots');
      await mkdir(dir, { recursive: true });
      filePath = join(dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
      await writeFile(filePath, Buffer.from(base64, 'base64'));
    } catch {
      filePath = undefined;
    }

    return {
      ...(filePath ? { filePath } : { screenshot: `data:image/png;base64,${base64}` }),
      fullPage: data.fullPage ?? false,
      selector: data.selector,
      annotated: data.annotate,
      marks: marks ?? undefined,
      viewport: viewport ?? undefined,
      mode: ctx.mode,
    };
  },
};
