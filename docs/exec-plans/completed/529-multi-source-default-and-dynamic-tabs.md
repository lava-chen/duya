# Plan 529: Multi-Source Default Marketplace + Dynamic Source Tabs + Catalog Dedup

> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-09-13
> **Companion**: [528-marketplace-source-fallback-mirror](./528-marketplace-source-fallback-mirror.md) (in flight: single source with multi-URL fallback), [455-codex-marketplace-and-install](./455-codex-marketplace-and-install.md) (foundation: single official source)
> **Source evidence**:
> - 2026-09-13 user feedback: "在 duya 里添加这个源。我看 ui 的话是可以在 duya 官方旁边加一个 tab 按钮是 claude code offical"
> - 2026-09-13 user feedback: "duya 官方如果 gitee 和 github 同时起作用的话插件列表会重复两次"

---

## 1. Problem & Goal

### Plan 528 left two real problems

**Problem A — Single source, no ecosystem**

Plan 528 made a single marketplace source (`name: 'official'`) survive a network blip by walking a `urls: [primary, mirror]` list. The result is still one catalog (one marketplace in the user's view), with one canonical "official" tab. **Useful for resilience, useless for breadth** — the user has no way to discover / install from the broader Claude Code ecosystem (`anthropics/claude-plugins-official`, 36.2k stars, Apache 2.0) without manual `marketplace add` gymnastics.

**Problem B — UI is hardcoded to two tabs**

`MarketplacePage.tsx:22,40,118` hardcodes:

```typescript
type MarketSource = "official" | "others";
const [source, setSource] = useState<MarketSource>("official");
// ...
const pluginsToShow = source === "official" ? officialPlugins : otherPlugins;
```

Even if `claude-plugins-official` were registered as a separate marketplace, there is no way to give it its own tab — the page only knows two static labels.

**Problem C — Catalog has no dedup**

`electron/plugins/catalog.ts:355-360` reads each marketplace and pushes every plugin entry directly into `entries[]` with no dedup. If the user (or a future source manager feature) registers the same physical repo twice (e.g. a gitee and a github mirror, or a sync failure that briefly leaves both clones in the cache), each plugin shows up twice in the UI.

### Goal

1. **Default sources**: `ensureOfficialMarketplace` seeds **two** marketplaces by default —
   - `duya-official` (gitee primary + github mirror) — same as today, plan 528 carries it
   - `claude-plugins-official` (`https://github.com/anthropics/claude-plugins-official.git`) — new
2. **Dynamic tabs**: `MarketplacePage` renders one tab per configured marketplace, using `MarketplaceSourceConfig.displayName` as the tab label. Falls back to `name` when no displayName. "All" / "Others" tabs only appear when relevant (community sources exist).
3. **Catalog dedup**: `getMarketplaceCatalogEntries` dedups by plugin `id`, first-write-wins (source iteration order matches the configured order).
4. **Schema migration**: backward-compatible. Existing users with `name: 'official'` keep their data; the new `claude-plugins-official` is only added if the user upgrades.

### Non-goals (this plan does NOT do)

- ❌ Allow per-source `tabGroup` / category grouping — tab is one-per-source
- ❌ Add a "featured / trending" tab sourced from a remote aggregator
- ❌ Reimplement the source manager UI (the "Add marketplace" dialog) — only the rendered tabs change
- ❌ Surface `claude-plugins-official` plugin counts in marketing/onboarding (silent inclusion, ready for users to discover)
- ❌ Source-side attribution / license disclosure beyond what `marketplace.json` provides
- ❌ Push the Anthropic marketplace's `external_plugins/` into duya — we only **read** their directory, do not contribute back

---

## 2. Design

### 2.1 `MarketplaceSourceConfig` schema addition

`electron/plugins/marketplace/git-source.ts`:

```typescript
export interface MarketplaceSourceConfig {
  source: 'git' | 'local';
  /** Legacy single URL — kept for back-compat with existing configs and UI forms. */
  url?: string;
  /** Ordered list of git URLs (primary → mirror). Wins over `url` when set. */
  urls?: string[];
  /** Optional UI tab label override. Falls back to `name` when not set. */
  displayName?: string;
  path?: string;
  ref?: string;
}
```

The `name` field for a marketplace lives one level up in the `marketplaces` map (`Record<string, MarketplaceSourceConfig>`), not inside the config itself. So the existing structure is unchanged; we add one optional string.

### 2.2 `DEFAULT_OFFICIAL_SOURCES` array

`electron/plugins/marketplace/manager.ts` — replaces `DEFAULT_OFFICIAL_SOURCE`:

```typescript
export const DEFAULT_OFFICIAL_MARKETPLACE = 'official';
export const DEFAULT_OFFICIAL_SOURCES: MarketplaceSourceConfig[] = [
  {
    source: 'git',
    displayName: 'DUYA Official',
    // Gitee primary (国内 + 海外连接都好), GitHub mirror as fallback.
    // plan 528 — marketplace source fallback / mirror.
    urls: [
      'https://gitee.com/lava-chen/duya-marketplace.git',
      'https://github.com/lava-chen/duya-marketplace.git',
    ],
  },
  {
    source: 'git',
    displayName: 'Claude Code Official',
    // anthropics/claude-plugins-official — Anthropic-managed, 36.2k stars,
    // Apache 2.0, the canonical Claude Code plugin directory.
    // plan 529 — adds it as a second seeded marketplace.
    urls: ['https://github.com/anthropics/claude-plugins-official.git'],
  },
];

// Back-compat: existing code that imports the singular form.
export const DEFAULT_OFFICIAL_SOURCE: MarketplaceSourceConfig =
  DEFAULT_OFFICIAL_SOURCES[0];
```

`ensureOfficialMarketplace` becomes:

```typescript
export async function ensureOfficialMarketplace(...): Promise<void> {
  const configs = getConfigMarketplaces();
  for (const source of DEFAULT_OFFICIAL_SOURCES) {
    if (configs[DEFAULT_OFFICIAL_MARKETPLACE] && source === DEFAULT_OFFICIAL_SOURCES[0]) {
      // legacy seed: skip if old 'official' name already exists
      continue;
    }
    // generate a stable name; collide with existing keys? Skip — never overwrite.
    const name = source.displayName === 'DUYA Official'
      ? DEFAULT_OFFICIAL_MARKETPLACE
      : 'claude-plugins-official';
    if (configs[name]) continue;
    configs[name] = { ...source, addedAt: new Date().toISOString() };
    saveMarketplaces(configs);
    logger.info('Seeded default official marketplace', {
      name,
      url: resolveSourceUrls(source)[0],
    }, COMPONENT);
  }
}
```

(`ensureOfficialMarketplace` body also needs minor edits to mirror the new structure; full sketch lives in the implementation steps.)

### 2.3 Catalog dedup — first-wins

`electron/plugins/catalog.ts:325-374` — `getMarketplaceCatalogEntries`:

```typescript
function getMarketplaceCatalogEntries(): {
  entries: PluginCatalogEntry[];
  statuses: MarketplaceCatalogStatus[];
} {
  // ... existing setup ...

  // Plan 529: dedup by plugin id across marketplaces. First marketplace wins
  // (registered order matches config insertion order; duya-official is seeded
  // first, so it has precedence over community mirrors).
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const seenDirs = new Set<string>();   // dedup-by-directory: same on-disk clone

  for (const [name, config] of Object.entries(readConfigMarketplaces())) {
    const dir = marketplaceDirFor(name, config);
    if (!dir || !fs.existsSync(dir)) { /* ... */ continue; }
    // ... existing manifest load ...
    for (const pluginEntry of manifest.plugins) {
      const entry = buildMarketplaceCatalogEntry(name, dir, pluginEntry);
      if (!entry) continue;
      const id = entry.id;
      const dirKey = path.resolve(dir);
      if (seenIds.has(id)) {
        logger.debug('Skipping duplicate plugin id across marketplaces', {
          id, name,
        }, COMPONENT);
        continue;
      }
      if (seenDirs.has(dirKey)) {
        logger.debug('Skipping duplicate marketplace directory', {
          name, dir: dirKey,
        }, COMPONENT);
        continue;
      }
      seenIds.add(id);
      seenDirs.add(dirKey);
      entries.push(entry);
      pluginCount++;
    }
  }
  return { entries, statuses };
}
```

Three-level dedup for safety:
1. **`id`** — the canonical `com.foo.bar` style plugin id; primary signal
2. **`dir`** — same on-disk clone (e.g. two configs pointing at the same `~/.duya/plugins/cache/marketplaces/duya-official/`)
3. (Implicit) `manifest.name` — used inside `buildMarketplaceCatalogEntry` to derive the id when `manifest.id` is missing

### 2.4 `MarketplacePage` — dynamic source tabs

`src/components/extensions/MarketplacePage.tsx`:

Remove `type MarketSource = "official" | "others"`. Instead, use the `marketplaces` state that the page already loads via `reloadMarketplaces()`. Render one tab per configured marketplace, plus a search/filter input that stays global.

```typescript
type TabDescriptor =
  | { kind: 'all' }
  | { kind: 'source'; name: string; displayName: string };

const [activeTab, setActiveTab] = useState<TabDescriptor>({ kind: 'all' });

const tabs: TabDescriptor[] = useMemo(() => {
  const sources: TabDescriptor[] = marketplaces.map((m) => ({
    kind: 'source',
    name: m.marketplace,
    displayName: m.displayName ?? m.marketplace,
  }));
  return [{ kind: 'all' }, ...sources];
}, [marketplaces]);

const pluginsToShow = useMemo(() => {
  let pool = filteredCatalog.filter((c) => c.kind !== 'skill');
  if (activeTab.kind === 'source') {
    pool = pool.filter((c) => c.marketplace === activeTab.name);
  }
  return pool;
}, [filteredCatalog, activeTab]);
```

UI render — replace the static `(["official", "others"] as MarketSource[])` map:

```tsx
<div className="flex items-center gap-1">
  {tabs.map((tab) => {
    const isActive = /* id compare */;
    const label = tab.kind === 'all'
      ? t('marketplace.tabs.all')   // new i18n key
      : tab.displayName;
    return (
      <button key={tab.kind === 'all' ? 'all' : tab.name}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(/* ... */)}>
        {label}
      </button>
    );
  })}
</div>
```

The existing `officialPlugins` / `otherPlugins` memoized split goes away. The `c.source === 'bundled'` builtin case is preserved — builtins show under "All" or under the "DUYA Official" tab depending on their `marketplace` field.

### 2.5 `MarketplaceViewDTO` extension

`src/lib/plugin-ipc.ts` — `MarketplaceViewDTO` already includes `marketplace: string`. Add an optional `displayName?: string` and `pluginCount: number` so the tab can show counts.

(Implementation reuses the existing `MarketplaceCatalogStatus` shape; just promote to the view DTO.)

### 2.6 i18n

`src/i18n/en.ts` / `src/i18n/zh.ts`:

- **Add** `marketplace.tabs.all` → "All" / "全部"
- **Keep** `marketplace.tabs.official` and `marketplace.tabs.others` for now (used by source manager UI in `MarketplacePage` itself — the collapsed panel that shows marketplace status). Defer deletion to a later plan if they go unused.

### 2.7 `MarketplaceSourceConfig` displayName in registry data

The registry already tracks `name` per source. We need to surface `displayName` and `pluginCount` to the renderer. Extension of the IPC payload is mechanical:

```typescript
// electron/plugins/catalog.ts
export function getMarketplaceStatuses(): MarketplaceCatalogStatus[] {
  const configs = readConfigMarketplaces();
  const statuses = getMarketplaceCatalogEntries().statuses;
  return statuses.map((s) => ({
    ...s,
    displayName: configs[s.marketplace]?.displayName ?? s.marketplace,
  }));
}
```

---

## 3. Implementation Steps

1. **`electron/plugins/marketplace/git-source.ts`**
   - Add `displayName?: string` to `MarketplaceSourceConfig`.

2. **`electron/plugins/marketplace/manager.ts`**
   - Replace `DEFAULT_OFFICIAL_SOURCE` with `DEFAULT_OFFICIAL_SOURCES: MarketplaceSourceConfig[]`.
   - Add `DEFAULT_OFFICIAL_SOURCES[0]` aliased back to `DEFAULT_OFFICIAL_SOURCE` for legacy imports (search & confirm no internal call site still uses the singular form; if any, leave it pointing at index 0).
   - Rewrite `ensureOfficialMarketplace` to seed both entries; for `duya-official` keep the legacy `name: 'official'` mapping; for `claude-plugins-official` add a new key.
   - Update `addMarketplace` so user-added sources default to `displayName: name` when missing (no schema bump on user input).

3. **`electron/plugins/catalog.ts`**
   - `getMarketplaceCatalogEntries`: add `seenIds`, `seenDirs` dedup sets; skip push + log debug when a duplicate is hit.
   - `getMarketplaceStatuses`: merge `displayName` from `readConfigMarketplaces()` into each status row.

4. **`src/lib/plugin-ipc.ts`**
   - `MarketplaceViewDTO`: add optional `displayName?: string` and reuse `pluginCount` from `MarketplaceCatalogStatus`.

5. **`src/components/extensions/MarketplacePage.tsx`**
   - Delete `MarketSource = "official" | "others"` alias.
   - Replace `useState<MarketSource>` with `useState<TabDescriptor>`.
   - Build `tabs` array from `marketplaces`.
   - Replace `pluginsToShow` filter accordingly.
   - Update the tab render JSX to map `tabs` instead of the static pair.
   - Keep `installedIds` and the existing install / detail callbacks untouched.

6. **`src/i18n/en.ts` and `src/i18n/zh.ts`**
   - Add `marketplace.tabs.all` entry in both.

7. **Tests**
   - `electron/plugins/marketplace/manager.test.ts` (new if absent): seed idempotency — running `ensureOfficialMarketplace` twice should not overwrite existing entries; running on a fresh store should add both `official` and `claude-plugins-official`.
   - `electron/plugins/__tests__/catalog.test.ts` (new): mount two marketplaces pointing at the same `marketplace.json` fixture (or reuse the existing fixture + add a second synthetic entry); assert the catalog exposes each plugin exactly once.
   - `src/components/extensions/__tests__/MarketplacePage.test.tsx` (extend existing or create): assert that the rendered tab count equals `marketplaces.length + 1` (All); click "Claude Code Official" tab; assert only Anthropic-sourced plugins are visible.

8. **`.claude/`** — not touched.

---

## 4. Verification

### Unit / type

- `npm run typecheck:all` must remain green.
- `npx vitest run electron/plugins/marketplace electron/plugins/__tests__/catalog.test.ts` — must include the new tests.
- `npx vitest run src/components/extensions/__tests__/MarketplacePage.test.tsx` — new dynamic-tab tests.

### Manual electron:dev

- Fresh userData (delete `~/.duya/plugins/cache/marketplaces/`, delete `[marketplaces]` from `config.toml`).
- `npm run electron:dev`. After first start, `app.log` should show:
  - `Seeded default official marketplace { name: 'official', url: 'https://gitee.com/...' }`
  - `Seeded default official marketplace { name: 'claude-plugins-official', url: 'https://github.com/anthropics/...' }`
- The MarketplaceModal renders three tabs: **All** / **DUYA Official** / **Claude Code Official**.
- DUYA Official tab shows the 27 duya-marketplace plugins.
- Claude Code Official tab shows the Anthropic catalog (visible only when the user has synced — if sync is slow on first open, the tab shows `0 plugins` and updates once sync finishes).
- Plugins appear in **at most one tab** (manual check: same id does not double-show).
- Restarting the app does **not** re-seed (idempotent).

### Non-regression

- Pre-existing users who already had `name: 'official'` in their `config.toml` keep that entry. Running ensure just adds `claude-plugins-official` next to it.
- Removing the `claude-plugins-official` source via the source manager still works (no schema checks added that block removal).

---

## 5. Risks

1. **Risk — Anthropic repo fetch fails in CI / dev sandbox.** Sandbox already lacks network in some setups; first-launch sync of `claude-plugins-official` will silently fall back to plan 528's WARN-and-skip path. The tab will appear with `0 plugins` until the user successfully syncs. **Mitigation**: documented in README / onboarding; the tab degrades gracefully rather than blocking the app.
2. **Risk — First-wins dedup changes today's behavior for any user who happened to register two sources with overlapping ids.** If a community source previously overrode the duya-official plugin by being seeded later, the new order reverses that. **Mitigation**: source iteration order matches `Object.entries(readConfigMarketplaces())` order, which is insertion order — duya-official is inserted at first launch and any user-added source is inserted afterward, so duya-official stays primary. Reverse is the explicit intent (user asked for "DUYA Official" precedence).
3. **Risk — Source manager UI displays raw URL when `displayName` is missing.** If a community-added source has no `displayName`, the tab falls back to the marketplace `name`. **Mitigation**: `addMarketplace` defaults `displayName: name` when missing (see step 2).
4. **Risk — `claude-plugins-official` repo uses a non-duya manifest format.** Inspect a sample manifest before implementation. If the Anthropic format diverges from duya's `duya.plugin.v1`, the buildMarketplaceCatalogEntry will log warnings on every plugin. **Mitigation**: catalog already handles non-local sources by skipping them (`buildMarketplaceCatalogEntry` returns null for `source.source !== 'local'`); the Anthropic repo's marketplace.json may need a thin adapter. **Defer** to a follow-up plan if it surfaces.
5. **Risk — `MarketplaceCatalogStatus` shape change breaks older renderer.** Adding optional `displayName` to the IPC payload is forward-compatible. Old renderer ignoring the field is fine. **Mitigation**: optional field.

---

## 6. Out of Scope

- ❌ tabGroup / featured tabs
- ❌ Remote aggregator / featured ranking
- ❌ Source manager UI rewrite
- ❌ Push duya plugins back to `external_plugins/` of the Anthropic repo
- ❌ Adaptive sync intervals / 24h background refresh (plan 455 already declared this out of scope)
- ❌ Npm-source marketplace entries
- ❌ Plan 528 doc status update — that's a follow-up commit to the plan text