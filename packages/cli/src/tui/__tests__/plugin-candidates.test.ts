/**
 * packages/cli/src/tui/__tests__/plugin-candidates.test.ts
 *
 * The `@` plugin candidate source.
 *
 * ## What these cases pin
 *
 *  1. Rows: one per ENABLED plugin, plugin rows before file paths is the
 *     composer's ordering concern — here only the row shape (label, value,
 *     capability summary) and the enabled filter.
 *
 *  2. Stale-while-revalidate: `list()` answers from cache immediately, one
 *     background refresh runs past the TTL, and `onUpdated` fires when the
 *     rows actually changed — the repaint hook an open popup needs.
 *
 *  3. The mention payload: `capabilities()` mirrors the inventory's
 *     component summaries and `connectedProviders()` keeps only
 *     `status === 'connected'` providers, because those two are exactly what
 *     the submit-time rewrite consumes.
 *
 *  4. A Host without the inventory (or a failing one) is an empty list, not
 *     a crash — and a failing refresh does not retry on every keystroke.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPluginCompletionSource } from '../plugin-candidates.js';

const INVENTORY = {
  plugins: [
    {
      id: 'wechat-pay',
      name: 'WeChat Pay',
      enabled: true,
      marketplace: 'official',
      installed: true,
      description: 'Payments over WeChat',
      appConnections: ['wechat_pay'],
      mcpServers: ['wechat-pay-server'],
      skillNames: ['wechat-pay-setup'],
    },
    {
      id: 'disabled-plugin',
      name: 'Disabled',
      enabled: false,
      installed: true,
    },
    {
      id: 'minimal',
      name: 'Minimal',
      installed: true,
    },
  ],
};

function tickQueue(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('createPluginCompletionSource', () => {
  it('offers one row per enabled plugin with a capability summary', async () => {
    const source = createPluginCompletionSource({
      listPlugins: async () => INVENTORY,
      listAppConnections: async () => [],
    });
    await source.refresh();

    const rows = source.list();
    expect(rows.map((row) => row.value)).toEqual(['wechat-pay', 'minimal']);
    expect(rows[0]).toMatchObject({
      label: 'WeChat Pay',
      value: 'wechat-pay',
      group: 'apps',
      category: 'context',
    });
    expect(rows[0]?.description).toContain('1 app · 1 MCP server · 1 skill');
  });

  it('refreshes in the background past the TTL and fires onUpdated only on change', async () => {
    let now = 1_000;
    const inventory = structuredClone(INVENTORY);
    const listPlugins = vi.fn(async () => inventory);
    const onUpdated = vi.fn();
    const source = createPluginCompletionSource(
      { listPlugins, listAppConnections: async () => [] },
      { ttlMs: 5_000, now: () => now, onUpdated },
    );
    await source.refresh();
    expect(onUpdated).toHaveBeenCalledTimes(1);

    // Inside the TTL: `list()` answers from cache and fetches nothing.
    source.list();
    await tickQueue();
    expect(listPlugins).toHaveBeenCalledTimes(1);

    // Past the TTL with an UNCHANGED inventory: a refresh runs but the popup
    // is not told, because repainting for identical rows is churn.
    now = 10_000;
    source.list();
    await tickQueue();
    expect(listPlugins).toHaveBeenCalledTimes(2);
    expect(onUpdated).toHaveBeenCalledTimes(1);

    // A plugin appears: the next refresh fires the repaint hook.
    inventory.plugins.push({ id: 'new-plugin', name: 'New', installed: true });
    now = 20_000;
    source.list();
    await tickQueue();
    expect(listPlugins).toHaveBeenCalledTimes(3);
    expect(onUpdated).toHaveBeenCalledTimes(2);
  });

  it('builds the mention payload the submit rewrite consumes', async () => {
    const source = createPluginCompletionSource({
      listPlugins: async () => INVENTORY,
      listAppConnections: async () => [
        { provider: 'wechat_pay', status: 'connected' },
        { provider: 'slack', status: 'connected' },
        { provider: 'google', status: 'error' },
      ],
    });
    await source.refresh();

    expect(source.capabilities()).toEqual([
      expect.objectContaining({
        pluginId: 'wechat-pay',
        name: 'WeChat Pay',
        appConnections: ['wechat_pay'],
        mcpServers: ['wechat-pay-server'],
        skillNames: ['wechat-pay-setup'],
      }),
      expect.objectContaining({ pluginId: 'minimal' }),
    ]);
    // Only live connections count: the mention activates what is usable.
    expect(source.connectedProviders()).toEqual(['wechat_pay', 'slack']);
  });

  it('answers an empty list for a client without the inventory methods', async () => {
    const source = createPluginCompletionSource({});
    await source.refresh();
    expect(source.list()).toEqual([]);
    expect(source.capabilities()).toEqual([]);
    expect(source.hasAnswered()).toBe(true);
  });

  it('survives a failing inventory without throwing or retrying per keystroke', async () => {
    const listPlugins = vi.fn(async () => {
      throw new Error('404 plugin_inventory_api_unavailable');
    });
    const source = createPluginCompletionSource(
      { listPlugins, listAppConnections: async () => [] },
      { ttlMs: 60_000, now: () => 0 },
    );
    await expect(source.refresh()).resolves.toBeUndefined();
    expect(source.list()).toEqual([]);

    // A keystroke inside the TTL re-reads the cache; the failed route is not
    // hammered again until the TTL expires.
    source.list();
    await tickQueue();
    expect(listPlugins).toHaveBeenCalledTimes(1);
  });
});
