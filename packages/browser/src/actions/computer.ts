/**
 * computer.ts — computer-use style browser actions.
 *
 * Coordinate-driven primitives that complement the ref/selector based
 * actions: click_at, mouse_move, drag, key_combo, scroll_to, refresh,
 * clipboard_read/write, handle_dialog. All of them dispatch real CDP
 * `Input.*` events, and when the active backend is human-like they reuse
 * its smooth cursor motion automatically.
 */

import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';
import {
  asHumanLike,
  dispatchMouseEvent,
  pressKeyWithModifiers,
  type MouseButton,
  type ModifierName,
} from '../input-dispatch.js';
import { safetyNoteForUrl } from '../safety.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireCdp(ctx: ActionContext) {
  if (!ctx.cdp) {
    throw new Error('This operation requires a real browser backend (not available in fallback mode)');
  }
  return ctx.cdp;
}

// ─── click_at ─────────────────────────────────────────────

const clickAtSchema = z.object({
  x: z.coerce.number().describe('Viewport X coordinate in CSS pixels'),
  y: z.coerce.number().describe('Viewport Y coordinate in CSS pixels'),
  button: z.enum(['left', 'right', 'middle']).optional().default('left')
    .describe('Mouse button. Use "right" for context menus.'),
  clickCount: z.coerce.number().int().min(1).max(2).optional().default(1)
    .describe('1 = single click, 2 = double click (word select / open).'),
});

export const clickAtAction: ActionHandler<z.infer<typeof clickAtSchema>> = {
  operation: 'click_at',
  schema: clickAtSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);
    const button = data.button as MouseButton;
    const clickCount = (data.clickCount === 2 ? 2 : 1) as 1 | 2;

    const human = asHumanLike(cdp);
    if (human) {
      await human.clickAt(data.x, data.y, { button, clickCount });
    } else {
      await dispatchMouseEvent(cdp, { type: 'mouseMoved', x: data.x, y: data.y });
      for (let count = 1; count <= clickCount; count++) {
        await dispatchMouseEvent(cdp, { type: 'mousePressed', x: data.x, y: data.y, button, clickCount: count });
        await sleep(30 + Math.random() * 60);
        await dispatchMouseEvent(cdp, { type: 'mouseReleased', x: data.x, y: data.y, button, clickCount: count });
        if (count < clickCount) await sleep(60 + Math.random() * 80);
      }
    }

    await sleep(300);
    const url = await cdp.getUrl();
    return {
      clickedAt: { x: data.x, y: data.y },
      button,
      clickCount,
      url,
      safetyNote: safetyNoteForUrl(url),
      mode: ctx.mode,
    };
  },
};

// ─── mouse_move ───────────────────────────────────────────

const mouseMoveSchema = z.object({
  x: z.coerce.number().describe('Viewport X coordinate in CSS pixels'),
  y: z.coerce.number().describe('Viewport Y coordinate in CSS pixels'),
});

export const mouseMoveAction: ActionHandler<z.infer<typeof mouseMoveSchema>> = {
  operation: 'mouse_move',
  schema: mouseMoveSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);
    const human = asHumanLike(cdp);
    if (human) {
      await human.moveMouseTo(data.x, data.y);
    } else {
      await dispatchMouseEvent(cdp, { type: 'mouseMoved', x: data.x, y: data.y });
    }
    return { movedTo: { x: data.x, y: data.y }, mode: ctx.mode };
  },
};

// ─── drag ─────────────────────────────────────────────────

const dragSchema = z.object({
  fromX: z.coerce.number().describe('Start viewport X coordinate'),
  fromY: z.coerce.number().describe('Start viewport Y coordinate'),
  toX: z.coerce.number().describe('End viewport X coordinate'),
  toY: z.coerce.number().describe('End viewport Y coordinate'),
  steps: z.coerce.number().int().min(2).max(100).optional().default(20)
    .describe('Intermediate mousemove events during the drag.'),
});

export const dragAction: ActionHandler<z.infer<typeof dragSchema>> = {
  operation: 'drag',
  schema: dragSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);
    const human = asHumanLike(cdp);

    if (human) {
      await human.moveMouseTo(data.fromX, data.fromY);
    } else {
      await dispatchMouseEvent(cdp, { type: 'mouseMoved', x: data.fromX, y: data.fromY });
    }
    await sleep(40);
    await dispatchMouseEvent(cdp, {
      type: 'mousePressed', x: data.fromX, y: data.fromY, button: 'left', clickCount: 1,
    });
    await sleep(60);

    if (human) {
      await human.moveMouseTo(data.toX, data.toY);
    } else {
      for (let i = 1; i <= data.steps; i++) {
        const t = i / data.steps;
        await dispatchMouseEvent(cdp, {
          type: 'mouseMoved',
          x: data.fromX + (data.toX - data.fromX) * t,
          y: data.fromY + (data.toY - data.fromY) * t,
        });
        await sleep(10);
      }
    }

    await sleep(40);
    await dispatchMouseEvent(cdp, {
      type: 'mouseReleased', x: data.toX, y: data.toY, button: 'left', clickCount: 1,
    });
    return {
      dragged: { from: { x: data.fromX, y: data.fromY }, to: { x: data.toX, y: data.toY } },
      mode: ctx.mode,
    };
  },
};

// ─── key_combo ────────────────────────────────────────────

const keyComboSchema = z.object({
  key: z.string().describe('Main key, e.g. "a", "Enter", "Tab", "F5", "ArrowDown"'),
  modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().default([])
    .describe('Held modifiers, e.g. ["ctrl"] for Ctrl+A. Use "meta" for Cmd on macOS.'),
});

export const keyComboAction: ActionHandler<z.infer<typeof keyComboSchema>> = {
  operation: 'key_combo',
  schema: keyComboSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);
    const modifiers = data.modifiers as ModifierName[];
    await pressKeyWithModifiers(cdp, data.key, modifiers);
    const combo = [...modifiers.map((m) => m === 'ctrl' ? 'Ctrl' : m[0].toUpperCase() + m.slice(1)), data.key].join('+');
    return { pressed: combo, mode: ctx.mode };
  },
};

// ─── scroll_to ────────────────────────────────────────────

const scrollToSchema = z.object({
  ref: z.string().optional().describe('Element ref ("@3") or CSS selector to scroll into view'),
  x: z.coerce.number().optional().describe('Absolute horizontal scroll position'),
  y: z.coerce.number().optional().describe('Absolute vertical scroll position'),
});

export const scrollToAction: ActionHandler<z.infer<typeof scrollToSchema>> = {
  operation: 'scroll_to',
  schema: scrollToSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);

    if (data.ref) {
      const selector = data.ref.startsWith('@')
        ? `[data-duya-ref="${data.ref.slice(1)}"]`
        : data.ref;
      const found = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      })()`);
      if (!found) {
        return { error: `Element not found: ${data.ref}`, mode: ctx.mode };
      }
      return { scrolledTo: data.ref, mode: ctx.mode };
    }

    if (data.x !== undefined || data.y !== undefined) {
      await cdp.evaluate(`(() => {
        const x = ${data.x ?? 'window.scrollX'};
        const y = ${data.y ?? 'window.scrollY'};
        window.scrollTo(x, y);
      })()`);
      return { scrolledTo: { x: data.x ?? 'current', y: data.y ?? 'current' }, mode: ctx.mode };
    }

    return { error: 'Provide either ref or x/y coordinates', mode: ctx.mode };
  },
};

// ─── refresh ──────────────────────────────────────────────

const refreshSchema = z.object({
  hard: z.boolean().optional().default(false).describe('Ignore cache (hard reload)'),
});

export const refreshAction: ActionHandler<z.infer<typeof refreshSchema>> = {
  operation: 'refresh',
  schema: refreshSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);
    await cdp.evaluate(`location.reload(${data.hard ? 'true' : 'false'})`);
    try {
      await cdp.waitForLoad(15000);
    } catch { /* page may keep loading async resources; proceed anyway */ }
    return {
      refreshed: true,
      hard: data.hard,
      url: await cdp.getUrl(),
      title: await cdp.getTitle(),
      mode: ctx.mode,
    };
  },
};

// ─── clipboard_read ───────────────────────────────────────

const clipboardReadSchema = z.object({});

export const clipboardReadAction: ActionHandler<z.infer<typeof clipboardReadSchema>> = {
  operation: 'clipboard_read',
  schema: clipboardReadSchema,
  async execute(_data, ctx) {
    const cdp = requireCdp(ctx);
    try {
      const text = await cdp.evaluate(`(async () => await navigator.clipboard.readText())()`);
      return { text: typeof text === 'string' ? text : String(text ?? ''), mode: ctx.mode };
    } catch (error) {
      return {
        error: `Clipboard read denied: ${error instanceof Error ? error.message : 'permission required'}. Focus the page first (click_at) or use key_combo Ctrl+V into a field instead.`,
        mode: ctx.mode,
      };
    }
  },
};

// ─── clipboard_write ──────────────────────────────────────

const clipboardWriteSchema = z.object({
  text: z.string().describe('Text to copy into the clipboard'),
});

export const clipboardWriteAction: ActionHandler<z.infer<typeof clipboardWriteSchema>> = {
  operation: 'clipboard_write',
  schema: clipboardWriteSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);
    try {
      await cdp.evaluate(`(async () => { await navigator.clipboard.writeText(${JSON.stringify(data.text)}); })()`);
      return { copied: data.text.length, mode: ctx.mode };
    } catch (error) {
      return {
        error: `Clipboard write denied: ${error instanceof Error ? error.message : 'permission required'}. Use the type operation as an alternative.`,
        mode: ctx.mode,
      };
    }
  },
};

// ─── handle_dialog ────────────────────────────────────────

const handleDialogSchema = z.object({
  action: z.enum(['accept', 'dismiss']).describe('accept = OK/confirm, dismiss = cancel/close'),
  promptText: z.string().optional().describe('Text to enter when the dialog is a prompt()'),
});

export const handleDialogAction: ActionHandler<z.infer<typeof handleDialogSchema>> = {
  operation: 'handle_dialog',
  schema: handleDialogSchema,
  async execute(data, ctx) {
    const cdp = requireCdp(ctx);
    try {
      await cdp.send('Page.enable').catch(() => {});
      await cdp.send('Page.handleJavaScriptDialog', {
        accept: data.action === 'accept',
        promptText: data.promptText,
      });
      const url = await cdp.getUrl().catch(() => '');
      return {
        dialog: data.action,
        safetyNote: data.action === 'accept' ? safetyNoteForUrl(url) : undefined,
        mode: ctx.mode,
      };
    } catch (error) {
      return {
        error: `No dialog is currently open (or backend rejected the command): ${error instanceof Error ? error.message : 'unknown'}`,
        mode: ctx.mode,
      };
    }
  },
};
