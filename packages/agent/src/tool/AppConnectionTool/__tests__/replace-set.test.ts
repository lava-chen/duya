/**
 * Plan 580 Phase 2C (D6) — replace-set semantics for chain B
 * App-Connection tools.
 *
 * Covers the two plan-mandated regressions plus the surrounding
 * guarantees:
 *   1. 46 → remove one connection → 45, no ghost keys (the legacy
 *      prefix-table cleanup leaked `remote_*` tools; buckets fix that).
 *   2. 46 → discovery network error → still 46 (last-known kept).
 *   3. Mixed: one connection's discovery fails while another shrinks.
 *   4. Owner isolation across buckets.
 *   5. `connection:removed` with a fresh per-turn registry (bucket
 *      absent) must not throw.
 *   6. Back-compat: callers that omit `connectedConnectionIds` behave
 *      exactly like the pre-580 full-swap cache.
 *   7. D7 namespace stamping on meta (slug / bare provider).
 *
 * The module under test holds module-level state (`cachedDescriptors`,
 * `pendingRemovedOwners`), so every test re-imports it through
 * `vi.resetModules()` for isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../registry.js';
import type { AppConnectionToolDescriptor } from '../index.js';

beforeEach(() => {
  vi.resetModules();
});

async function loadModule() {
  return import('../index.js');
}

/** Build 45 notion-style remote tools for one connection. */
function notionDescriptors(connectionId: string, count = 45, slug?: string): AppConnectionToolDescriptor[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `remote_notion_tool_${String(i + 1).padStart(3, '0')}`;
    const desc: AppConnectionToolDescriptor = {
      name,
      description: `${name} description`,
      inputSchema: { type: 'object', properties: {} },
      inputSchemaSummary: 'object',
      riskTier: 'read',
      provider: 'notion',
      connectionId,
      action: `notion.${name}`,
    };
    if (slug !== undefined) desc.connectionSlug = slug;
    return desc;
  });
}

function slackDescriptor(connectionId: string, name = 'remote_slack_send'): AppConnectionToolDescriptor {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    inputSchemaSummary: 'object',
    riskTier: 'write',
    provider: 'slack',
    connectionId,
    action: 'slack.send',
  };
}

async function seedInitial46(): Promise<{
  mod: Awaited<ReturnType<typeof loadModule>>;
  registry: ToolRegistry;
}> {
  const mod = await loadModule();
  const registry = new ToolRegistry();
  const connA = notionDescriptors('conn-A');
  const connB = [slackDescriptor('conn-B')];
  mod.setCachedAppConnectionDescriptors([...connA, ...connB], ['conn-A', 'conn-B']);
  const result = mod.registerAppConnectionTools(registry, [...connA, ...connB]);
  expect(result).toEqual({ added: 46, removed: 0, downgraded: 0 });
  expect(registry.size).toBe(46);
  return { mod, registry };
}

describe('plan 580 phase 2c — connection replace-set (D6)', () => {
  it('46 → one tool disappears from conn-A → 45 with no ghost keys', async () => {
    const { mod, registry } = await seedInitial46();

    // conn-A's discovery succeeds again but the remote server dropped
    // one tool (46 → 45). The bucket is authoritatively replaced with
    // the fresh 44-key inventory.
    const fresh44 = notionDescriptors('conn-A').slice(0, 44);
    const connB = [slackDescriptor('conn-B')];
    mod.setCachedAppConnectionDescriptors([...fresh44, ...connB], ['conn-A', 'conn-B']);
    const result = mod.registerAppConnectionTools(registry, [...fresh44, ...connB]);

    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(registry.size).toBe(45);

    // The dropped tool is gone — including its `remote_*` name the
    // legacy prefix-table cleanup could never cover.
    expect(registry.has('remote_notion_tool_045')).toBe(false);
    expect(registry.getOwner('remote_notion_tool_045')).toBeUndefined();

    // The surviving 44 conn-A tools plus conn-B remain.
    expect(registry.has('remote_notion_tool_044')).toBe(true);
    expect(registry.getOwner('remote_notion_tool_044')).toBe('connector:conn-A');
    expect(registry.has('remote_slack_send')).toBe(true);
  });

  it('46 → remove whole conn-A → 1 with no ghost keys', async () => {
    const { mod, registry } = await seedInitial46();

    // conn-A is disconnected/removed by the user: the main process no
    // longer reports it as connected and sends no descriptors for it.
    const connB = [slackDescriptor('conn-B')];
    mod.setCachedAppConnectionDescriptors(connB, ['conn-B']);
    const result = mod.registerAppConnectionTools(registry, connB);

    // The empty-replace for conn-A's bucket removed exactly 45 keys.
    expect(result.removed).toBe(45);
    expect(result.added).toBe(0);
    expect(registry.size).toBe(1);

    // No ghost keys: every conn-A tool is gone, including `remote_*`
    // names the legacy prefix-table cleanup could never cover.
    for (let i = 1; i <= 45; i++) {
      const name = `remote_notion_tool_${String(i).padStart(3, '0')}`;
      expect(registry.has(name)).toBe(false);
      expect(registry.getOwner(name)).toBeUndefined();
    }

    // conn-B survives untouched.
    expect(registry.has('remote_slack_send')).toBe(true);
    expect(registry.getOwner('remote_slack_send')).toBe('connector:conn-B');
  });

  it('46 → discovery fails for both connections → still 46 (last-known kept)', async () => {
    const { mod, registry } = await seedInitial46();

    // Discovery threw on the main side: descriptors are empty, but both
    // connection rows are still status='connected', so they remain in
    // the authoritative connected set AND are reported as discovery
    // failures (D6: discovery:failed does NOT replace — the last-known
    // inventory stays authoritative).
    mod.setCachedAppConnectionDescriptors([], ['conn-A', 'conn-B'], ['conn-A', 'conn-B']);
    const result = mod.registerAppConnectionTools(registry, mod.getCachedAppConnectionDescriptors());

    expect(result.removed).toBe(0);
    expect(result.added).toBe(0);
    expect(registry.size).toBe(46);
    expect(registry.has('remote_notion_tool_001')).toBe(true);
    expect(registry.has('remote_notion_tool_045')).toBe(true);
    expect(registry.has('remote_slack_send')).toBe(true);

    // Nothing was queued for removal — the cache still holds all 46.
    expect(mod.getCachedAppConnectionDescriptors()).toHaveLength(46);
  });

  it('mixed: conn-A discovery fails (kept), conn-B discovery succeeds empty (cleared)', async () => {
    const { mod, registry } = await seedInitial46();

    // conn-B's discovery succeeded but returned an empty inventory (the
    // remote server genuinely lost its tools) — D6 says authoritative
    // empty replace. conn-A's discovery failed outright — keep
    // last-known.
    mod.setCachedAppConnectionDescriptors([], ['conn-A', 'conn-B'], ['conn-A']);

    const cached = mod.getCachedAppConnectionDescriptors();
    expect(cached).toHaveLength(45);
    expect(cached.every((d) => d.connectionId === 'conn-A')).toBe(true);

    const result = mod.registerAppConnectionTools(registry, cached);
    // conn-B's bucket is authoritatively emptied; conn-A's last-known
    // re-commit keeps its 45 keys.
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(registry.size).toBe(45);
    expect(registry.has('remote_slack_send')).toBe(false);
    expect(registry.has('remote_notion_tool_001')).toBe(true);
    expect(registry.getOwner('remote_notion_tool_001')).toBe('connector:conn-A');
  });

  it('owner isolation: replacing conn-B never touches conn-A entries', async () => {
    const { mod, registry } = await seedInitial46();

    const connB = [slackDescriptor('conn-B', 'remote_slack_post')];
    mod.setCachedAppConnectionDescriptors(
      [...notionDescriptors('conn-A'), ...connB],
      ['conn-A', 'conn-B'],
    );
    mod.registerAppConnectionTools(registry, [...notionDescriptors('conn-A'), ...connB]);

    // conn-B's key changed (replace), conn-A's keys stayed.
    expect(registry.has('remote_slack_send')).toBe(false);
    expect(registry.has('remote_slack_post')).toBe(true);
    for (let i = 1; i <= 45; i++) {
      expect(registry.has(`remote_notion_tool_${String(i).padStart(3, '0')}`)).toBe(true);
    }
    expect(registry.getOwner('remote_slack_post')).toBe('connector:conn-B');
  });

  it('removed owner with an absent bucket does not throw (fresh per-turn registry)', async () => {
    const mod = await loadModule();
    // Cache a connection, then drop it — the pending removed owner is
    // recorded but the next registration happens on a brand-new
    // registry where the bucket never existed.
    mod.setCachedAppConnectionDescriptors(notionDescriptors('conn-gone', 2), ['conn-gone']);
    mod.setCachedAppConnectionDescriptors([], []);
    const fresh = new ToolRegistry();
    expect(() =>
      mod.registerAppConnectionTools(fresh, []),
    ).not.toThrow();
    expect(fresh.size).toBe(0);
  });

  it('omitting connectedConnectionIds keeps pre-580 full-swap behaviour', async () => {
    const mod = await loadModule();
    const registry = new ToolRegistry();
    const first = [...notionDescriptors('conn-A', 2), slackDescriptor('conn-B')];
    mod.setCachedAppConnectionDescriptors(first);
    mod.registerAppConnectionTools(registry, first);
    expect(registry.size).toBe(3);

    // No connected set: the new descriptor list is the whole truth.
    const second = [slackDescriptor('conn-B', 'remote_slack_post')];
    mod.setCachedAppConnectionDescriptors(second);
    const result = mod.registerAppConnectionTools(registry, second);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(3);
    expect(registry.size).toBe(1);
    expect(mod.getCachedAppConnectionDescriptors()).toHaveLength(1);
  });

  it('meta namespace: bare provider without slug, provider:slug with one', async () => {
    const mod = await loadModule();
    const registry = new ToolRegistry();
    const descs = [
      { ...notionDescriptors('conn-A', 1)[0]!, connectionSlug: undefined },
      { ...slackDescriptor('conn-B', 'remote_slack_ping'), connectionSlug: 'abc123' },
    ];
    mod.setCachedAppConnectionDescriptors(descs, ['conn-A', 'conn-B']);
    mod.registerAppConnectionTools(registry, descs);

    // First connection holds the bare namespace for life (D7); a later
    // connection gets provider:slug.
    expect(registry.getMeta('remote_notion_tool_001')?.discovery?.namespace).toBe('notion');
    expect(registry.getMeta('remote_slack_ping')?.discovery?.namespace).toBe('slack:abc123');
  });
});
