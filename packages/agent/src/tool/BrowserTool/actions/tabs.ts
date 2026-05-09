import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

// ─── tabs_list ────────────────────────────────────────────

const tabsListSchema = z.object({});

export const tabsListAction: ActionHandler<z.infer<typeof tabsListSchema>> = {
  operation: 'tabs_list',
  schema: tabsListSchema,
  async execute(_data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Tab management not available in fallback mode', mode: 'fallback' };
    }
    const tabs = await ctx.cdp.tabs();
    return {
      tabs: tabs.map((tab, index) => ({
        index,
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
      })),
      count: tabs.length,
      mode: ctx.mode,
    };
  },
};

// ─── tabs_new ─────────────────────────────────────────────

const tabsNewSchema = z.object({
  url: z.string().optional().describe('Optional URL to open in new tab'),
});

export const tabsNewAction: ActionHandler<z.infer<typeof tabsNewSchema>> = {
  operation: 'tabs_new',
  schema: tabsNewSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Tab management not available in fallback mode', mode: 'fallback' };
    }
    const tabId = await ctx.cdp.newTab(data.url);
    return { newTabId: tabId, url: data.url, mode: ctx.mode };
  },
};

// ─── tabs_close ───────────────────────────────────────────

const tabsCloseSchema = z.object({
  target: z.union([z.number(), z.string()]).optional().describe('Tab index or ID to close (defaults to current)'),
});

export const tabsCloseAction: ActionHandler<z.infer<typeof tabsCloseSchema>> = {
  operation: 'tabs_close',
  schema: tabsCloseSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Tab management not available in fallback mode', mode: 'fallback' };
    }
    await ctx.cdp.closeTab(data.target);
    return { closed: data.target ?? 'current', mode: ctx.mode };
  },
};

// ─── tabs_select ──────────────────────────────────────────

const tabsSelectSchema = z.object({
  target: z.union([z.number(), z.string()]).describe('Tab index or ID to select'),
});

export const tabsSelectAction: ActionHandler<z.infer<typeof tabsSelectSchema>> = {
  operation: 'tabs_select',
  schema: tabsSelectSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Tab management not available in fallback mode', mode: 'fallback' };
    }
    await ctx.cdp.selectTab(data.target);
    return {
      selected: data.target,
      url: await ctx.cdp.getUrl(),
      title: await ctx.cdp.getTitle(),
      mode: ctx.mode,
    };
  },
};
