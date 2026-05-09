import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

// ─── click ────────────────────────────────────────────────

const clickSchema = z.object({
  ref: z.string().describe('Element ref (e.g., "@3") or CSS selector to click'),
});

export const clickAction: ActionHandler<z.infer<typeof clickSchema>> = {
  operation: 'click',
  schema: clickSchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      // Scroll element into view before clicking
      if (data.ref.startsWith('@')) {
        const ref = data.ref.slice(1);
        try {
          await ctx.cdp.evaluate(
            `(()=>{const e=document.querySelector('[data-duya-ref="${ref}"]');if(e)e.scrollIntoView({block:'center',behavior:'instant'});})()`
          );
        } catch { /* best effort */ }
      }
      await ctx.cdp.click(data.ref);
      await new Promise(resolve => setTimeout(resolve, 300));
      return {
        clicked: data.ref,
        url: await ctx.cdp.getUrl(),
        mode: ctx.mode,
      };
    }

    if (!ctx.fallbackBrowser) throw new Error('Browser not initialized');
    return await ctx.fallbackBrowser.click(data.ref);
  },
};

// ─── type ─────────────────────────────────────────────────

const typeSchema = z.object({
  ref: z.string().describe('Element ref (e.g., "@1") or CSS selector to type into'),
  text: z.string().describe('Text to type'),
  submit: z.boolean().optional().default(false).describe('Press Enter after typing'),
});

export const typeAction: ActionHandler<z.infer<typeof typeSchema>> = {
  operation: 'type',
  schema: typeSchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      await ctx.cdp.type(data.ref, data.text);
      if (data.submit) {
        await ctx.cdp.pressKey('Enter');
      }
      return {
        typed: data.text,
        into: data.ref,
        submitted: data.submit,
        mode: ctx.mode,
      };
    }

    if (!ctx.fallbackBrowser) throw new Error('Browser not initialized');
    return await ctx.fallbackBrowser.type(data.ref, data.text);
  },
};

// ─── scroll ───────────────────────────────────────────────

const scrollSchema = z.object({
  direction: z.enum(['up', 'down', 'left', 'right']).optional().default('down').describe('Scroll direction'),
  amount: z.number().optional().default(300).describe('Scroll amount in pixels'),
});

export const scrollAction: ActionHandler<z.infer<typeof scrollSchema>> = {
  operation: 'scroll',
  schema: scrollSchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      await ctx.cdp.scroll(data.direction, data.amount);
      return { direction: data.direction, amount: data.amount, mode: ctx.mode };
    }
    return { error: 'Scroll not available in fallback mode', mode: 'fallback' };
  },
};

// ─── press_key ────────────────────────────────────────────

const pressKeySchema = z.object({
  key: z.string().describe('Key to press (Enter, Tab, Escape, ArrowUp, ArrowDown, etc.)'),
});

export const pressKeyAction: ActionHandler<z.infer<typeof pressKeySchema>> = {
  operation: 'press_key',
  schema: pressKeySchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      await ctx.cdp.pressKey(data.key);
      return { key: data.key, mode: ctx.mode };
    }
    return { error: 'Key press not available in fallback mode', mode: 'fallback' };
  },
};

// ─── hover ────────────────────────────────────────────────

const hoverSchema = z.object({
  ref: z.string().describe('Element ref (e.g., "@3") or CSS selector to hover over'),
});

export const hoverAction: ActionHandler<z.infer<typeof hoverSchema>> = {
  operation: 'hover',
  schema: hoverSchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      await ctx.cdp.hover(data.ref);
      return { hovered: data.ref, mode: ctx.mode };
    }
    return { error: 'Hover not available in fallback mode', mode: 'fallback' };
  },
};

// ─── wait ─────────────────────────────────────────────────

const waitSchema = z.object({
  type: z.enum(['ms', 'element', 'load']).describe('Wait type: ms (milliseconds), element (wait for element), load (wait for page load)'),
  value: z.string().optional().describe('Value: milliseconds for ms, selector for element'),
  timeoutMs: z.number().optional().default(15000).describe('Maximum wait time in milliseconds'),
});

export const waitAction: ActionHandler<z.infer<typeof waitSchema>> = {
  operation: 'wait',
  schema: waitSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Wait not available in fallback mode', mode: 'fallback' };
    }

    if (data.type === 'ms') {
      const ms = parseInt(data.value || '1000', 10);
      await new Promise(resolve => setTimeout(resolve, Math.min(ms, 30000)));
      return { waitedMs: ms, mode: ctx.mode };
    }

    if (data.type === 'element' && data.value) {
      await ctx.cdp.waitForElement(data.value, data.timeoutMs);
      return { elementFound: data.value, mode: ctx.mode };
    }

    if (data.type === 'load') {
      await ctx.cdp.waitForLoad(data.timeoutMs);
      return { pageLoaded: true, mode: ctx.mode };
    }

    return { error: `Unknown wait type: ${data.type}`, mode: ctx.mode };
  },
};
