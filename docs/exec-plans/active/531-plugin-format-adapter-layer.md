# Plan 531: Plugin Format Adapter Layer (one canonical model, N ecosystems)

> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-09-13
> **Companion**: [529-multi-source-default-and-dynamic-tabs](./529-multi-source-default-and-dynamic-tabs.md) (seeded `claude-plugins-official`), [455-codex-marketplace-and-install](./455-codex-marketplace-and-install.md) (the original single-format reader)
> **Source evidence**:
> - 2026-09-13: `claude-plugins-official` sync failed schema validation — Anthropic's catalog uses `git-subdir` / `url` / string sources and `.claude-plugin/plugin.json`, none of which duya knew.
> - 2026-09-13 user question: "如何才能一劳永逸的解决多重格式的问题?" with a pointer to Codex's plugin format (https://developers.openai.com/plugins/build/plugins).
> - The two-part hotfix (`9f69a1d2` marketplace-source preprocess, `50eaa0fa` foreign dot-folder probes + dedup fix) is the *first stage* of this plan, landed ad hoc. This plan generalizes it.

---

## 1. Problem & Goal

### The problem: format sprawl

The agent-plugin ecosystem now has several incompatible-but-overlapping formats, and duya wants to consume all of them without manual per-source work:

| Ecosystem | Plugin manifest location | Catalog (marketplace) shape | Source types seen |
| --- | --- | --- | --- |
| **duya** | `.duya-plugin/plugin.json` *or* root `plugin.json` | `{ source: { source: 'local'｜'git', … } }` | local path, git |
| **Claude Code** | `.claude-plugin/plugin.json` | plain string path, `{ source: 'git-subdir', url, path, ref, sha }`, `{ source: 'url', url, sha }` | local path, git subdir, git repo |
| **Codex / OpenAI** | `.codex-plugin/plugin.json` *or* portable root `plugin.json` (`$schema: agent-plugins.org/1.0.0`) | `codex plugin marketplace add` catalog | local, git, **npm**, zip, command |
| **Cursor** | `.cursor-plugin/plugin.json` | `.cursor-plugin/marketplace.json` | local, git |
| **Agent Plugins (portable)** | root `plugin.json` + `$schema` const | ecosystem-neutral | local, git |

Each new source today costs a bespoke conditional in `catalog.ts` / `manifest.ts` / `install`, plus a new round of "why is the tab empty" debugging. The two hotfixes already show the pattern: every format difference gets patched where it was discovered.

### Goal

Make "support a new plugin/catalog format" a **data change, not a code change**:

1. One canonical internal model (`MarketplaceManifest` + `PluginManifest`, already versioned `duya.plugin.v2`).
2. A **format adapter registry**: each supported ecosystem is one adapter module with `detect()` / `normalizeCatalog()` / `normalizePlugin()` / `probePaths`.
3. All format-specific logic lives in adapters. `catalog.ts`, install, and UI never branch on source-format again.
4. Every adapter is pinned by a **captured real-world fixture** so upstream format drift is caught by tests, not by an empty tab.

### Non-goals

- ❌ Executing non-local source types (npm / zip / command) beyond recognizing them — install-time materialization for those is a separate plan (plan 455 declared local+git only).
- ❌ A plugin *publishing* adapter (writing Claude/Codex formats back out).
- ❌ Cross-ecosystem capability *semantics* (e.g. translating a Claude slash-command into a duya CLI command) — only structural normalization.
- ❌ Network fetching of a schema at runtime; detection uses shape signals only.

---

## 2. Design

### 2.1 Layering

```
 raw JSON (unknown ecosystem)
        │
        ▼
 ┌──────────────────────────────────────────────┐
 │ format adapter registry  (THIS PLAN)          │
 │   detect() → adapter                          │
 │   adapter.normalizeCatalog() / .normalizePlugin()│
 │   adapter.probePaths  (location adapters)     │
 └──────────────────────────────────────────────┘
        │  canonical MarketplaceManifest / PluginManifest
        ▼
 catalog.ts · PluginManager · MarketplacePage      (unchanged downstream)
```

### 2.2 Adapter contract

`packages/plugin-core/src/formats/types.ts`:

```ts
export interface FormatAdapter {
  /** Stable id, e.g. 'duya' | 'claude-code' | 'codex' | 'cursor' | 'agent-plugins'. */
  id: string;
  /** Human label for logs / diagnostics. */
  label: string;
  /** Ordered probe order weight (lower = tried first). */
  priority: number;

  /**
   * Does this adapter own the given raw catalog / manifest? Detection must
   * key off a *structural marker*, never a fragile single field:
   *   - Agent Plugins  : $schema === agent-plugins 1.0.0
   *   - Claude Code    : plugins[].source is a string / git-subdir / url
   *   - Codex          : plugins[].source uses codex discriminators
   *   - duya native    : source is the local/git object union
   */
  detectCatalog?(raw: unknown): boolean;
  detectPlugin?(raw: unknown, layout?: PluginLayout): boolean;

  /** Normalize into the canonical model. Throw only on truly unusable input. */
  normalizeCatalog?(raw: unknown, ctx: AdapterCtx): MarketplaceManifest;
  normalizePlugin?(raw: unknown, ctx: AdapterCtx): PluginManifest;

  /**
   * Where this ecosystem keeps its plugin manifest, relative to a plugin
   * root. Location adapters are what let readPluginManifest find
   * `.claude-plugin/plugin.json` without a code change per ecosystem.
   */
  pluginManifestPaths?: readonly string[];

  /** Where this ecosystem keeps its catalog file, relative to a clone root. */
  catalogPaths?: readonly string[];
}
```

`PluginLayout = { dotFolder: string }` (e.g. `.claude-plugin`) so `detectPlugin` can use the folder signal, and `pluginManifestPaths` can be expressed as `[`.${id}/plugin.json`]`.

### 2.3 Registry

`packages/plugin-core/src/formats/registry.ts`:

```ts
const adapters: FormatAdapter[] = [];
export function registerFormat(a: FormatAdapter): void { adapters.push(a); adapters.sort(byPriority); }
export function detectCatalogFormat(raw: unknown): FormatAdapter | null { … }
export function detectPluginFormat(raw: unknown, layout?): FormatAdapter | null { … }
export function allPluginManifestPaths(): readonly string[] { … }   // union, priority-ordered
export function allCatalogPaths(): readonly string[] { … }
```

Default adapters register in `formats/index.ts` (side-effect import), mirroring the `modeModifierRegistry` pattern already used for modes.

### 2.4 The five adapters

- **`duya.ts`** — the current canonical shape. `detectCatalog`: `source.source === 'local' | 'git'`. `catalogPaths`: the existing `MARKETPLACE_MANIFEST_RELATIVE_PATHS`. `pluginManifestPaths`: `['.duya-plugin/plugin.json', 'plugin.json']`.
- **`claude-code.ts`** — `detectCatalog`: any `plugins[].source` is a string or has `source ∈ {git-subdir, url}`. `normalizeCatalog`: reuse the preprocess landed in `9f69a1d2` (string → local/git, git-subdir/url → git, `ref` → `ref_name`). `catalogPaths`: `['.claude-plugin/marketplace.json']`. `pluginManifestPaths`: `['.claude-plugin/plugin.json']`.
- **`codex.ts`** — `pluginManifestPaths`: `['.codex-plugin/plugin.json']`. Catalog: capture a real `codex plugin marketplace add` catalog as a fixture, then normalize (likely very close to Claude's). Codex's portable layout (root `plugin.json` + `$schema`) is owned by the agent-plugins adapter.
- **`cursor.ts`** — `pluginManifestPaths`: `['.cursor-plugin/plugin.json']`; `catalogPaths`: `['.cursor-plugin/marketplace.json']`.
- **`agent-plugins.ts`** — `detectPlugin`/`detectCatalog` keyed on `$schema === 'https://agent-plugins.org/schemas/1.0.0/...'`. duya already has `readAgentPluginsManifest` + `AGENT_PLUGINS_PLUGIN_SCHEMA`; this adapter simply formalizes ownership of that branch.

### 2.5 Boundary rules (what keeps it "一劳永逸")

1. **Sniff by structural marker.** Detection reads a marker (schema URL, discriminator value set, dot-folder), never "does field X exist".
2. **Tolerant at the edge, strict inside.** Adapters accept missing optional fields and emit a fully-valid canonical object; consumers never re-validate or re-branch.
3. **Preserve the unknown.** Adapters carry unrecognized fields through into `extensions`/`raw` so a newer upstream field is not silently dropped and can be surfaced later without a format-rerelease.
4. **Capabilities stay disk-driven.** `discoverAllCapabilities(pluginRoot)` is already format-agnostic (it walks `skills/`, `hooks/`, `.mcp.json`, `commands/`); adapters only normalize the *declared* manifest parts. This is a big part of why multi-format is tractable at all.
5. **Version the canonical model, not the adapters.** Adapters always emit the current canonical version (`duya.plugin.v2`); changing the model updates adapters, never consumers.
6. **Adding a format = add a row.** New ecosystem → one adapter file + one fixture + one registry line. No edits to `catalog.ts` / install / UI.

### 2.6 Diagnostics

Empty-tab debugging is the actual cost of format drift. Add a `duya plugin formats` diagnostic (CLI + a MarketplaceModal "Why is this empty?" affordance) that reports, per configured marketplace:

- detected adapter id (or `unknown`),
- catalog path found (or "none of the probed paths matched"),
- per-entry: normalized source kind, and skip reason if dropped (`git-source not materialized`, `plugin manifest not found at [paths]`, `duplicate id`).

---

## 3. Implementation Steps

1. **Extract the adapter contract + registry** in `packages/plugin-core/src/formats/` (`types.ts`, `registry.ts`, `index.ts`). Pure, no I/O.
2. **Port the two hotfixes into adapters** — move the `9f69a1d2` source preprocess into `formats/claude-code.ts`, and turn `50eaa0fa`'s dot-folder probe list into `pluginManifestPaths` on each adapter. Behavior must be bit-identical; the existing tests in `manifest.test.ts` (marketplace + plugin) are the guard.
3. **Refactor `electron/plugins/marketplace/manifest.ts`** to resolve the catalog path + adapter via the registry instead of hard-coded path lists, and to call `normalizeCatalog`.
4. **Refactor `electron/plugins/manifest.ts`** `readPluginManifest` to iterate `allPluginManifestPaths()` and dispatch `normalizePlugin` by detected format.
5. **Capture fixtures** under `packages/plugin-core/src/formats/__fixtures__/`: real (trimmed) `claude-plugins-official` catalog, a Codex catalog, a Cursor marketplace, an Agent Plugins package, a duya-native marketplace. One fixture per adapter minimum.
6. **Conformance tests** `formats/*.test.ts`: for each fixture, assert `detectCatalogFormat` picks the right adapter and `normalizeCatalog` yields the canonical shape; assert every path in `allPluginManifestPaths()` is covered by some adapter.
7. **Codex catalog research + adapter** once a real fixture is captured.
8. **`duya plugin formats` diagnostic** (CLI) + wire the skips into `MarketplaceCatalogStatus`.
9. **Docs**: a `docs/references/plugin-formats.md` "how to add a format" recipe (fixture → adapter → registry → test).
10. **ARCHITECTURE.md** note under the plugin section pointing at the adapter layer.

---

## 4. Verification

- `npm run typecheck:all` green (root config; `electron/**` is excluded, see the note below).
- `npx vitest run packages/plugin-core/src/formats` — new conformance suite green.
- `npx vitest run electron/plugins` — the pre-existing `catalog.test.ts` "no duplicate ids" failure must be *fixed or explicitly quarantined* as part of this plan (it currently fails because builtin and marketplace entries can share ids — the registry gives us one place to enforce global id uniqueness).
- Manual: configure duya-official + claude-plugins-official + a codex source; `duya plugin formats` reports the right adapter per source; the Claude tab lists local Anthropic plugins; git-source entries report the materialization skip reason.

---

## 5. Risks

1. **Over-abstraction.** The adapter layer must stay thin — if an adapter needs heavy logic, that is a signal the canonical model is missing a field, not that the adapter should grow. Keep adapters ≤ ~80 lines.
2. **Detection ambiguity.** A catalog could satisfy two detectors (e.g. a hybrid). Resolve by `priority` + a "first structural marker wins, log the others" rule; add a test for each ambiguous pair we know of.
3. **Codex catalog unknown.** Its marketplace catalog shape is not yet captured. Do the fixture capture before writing the codex adapter; do not guess (see the anti-pattern in memory: never invent formats).
4. **Silent upstream drift.** Fixtures freeze a snapshot; if Anthropic/Codex change shape, `detect` may stop matching and the tab goes empty again. Mitigate with the §2.6 diagnostics + a periodic fixture-refresh task (cron), not with looser detection.
5. **The pre-existing global-id-uniqueness bug.** `getPluginCatalog` can emit duplicate ids across the builtin/marketplace boundary. This plan should own the fix (one dedup point in the registry-driven merge) so the failing smoke test becomes a green guard.

---

## 6. Relationship to landed hotfixes

| Commit | What it did | Where it belongs in this plan |
| --- | --- | --- |
| `9f69a1d2` | marketplace `source` preprocess (Claude string / git-subdir / url → canonical) | `formats/claude-code.ts` `normalizeCatalog` |
| `50eaa0fa` | foreign dot-folder probes + marketplace dedup (dir-level) fix | `pluginManifestPaths` per adapter + `catalog.ts` dedup as a permanent invariant |

Both hotfixes are correct and shipped; the plan's job is to stop the *next* format from being another ad-hoc patch.