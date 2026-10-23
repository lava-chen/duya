# Agent E — UI package architecture (first-screen payload)

Measurement scripts for the shared renderer (`packages/ui`), used by the
Duya Desktop performance hill-climb plan
(`docs/exec-plans/active/2026-10-23-desktop-performance-hill-climbing.md`).

All three scripts run on node builtins plus Playwright (already a dev
dependency of the repo). They deliberately import nothing from `packages/` —
`e2e/` must not depend on product packages.

## Prerequisite build

```powershell
npm run build:packages            # workspace package dists (tsc)
node scripts/build-electron.mjs    # dist-electron/main.js + preload.js
npx vite build                    # dist/ (production renderer bundle)
```

`packages/host/bundle/worker-entry.js` must exist (tracked in the repo).

## 1. First-screen JS payload — `first-screen-payload.mjs`

```powershell
node e2e/perf/agents/agent-e/first-screen-payload.mjs
node e2e/perf/agents/agent-e/first-screen-payload.mjs --json
```

Reads the emitted `dist/` artifacts only:

1. `dist/index.html` names the entry chunk.
2. Every chunk is parsed for its **static** imports. Dynamic imports
   (`import("./x.js")`) are the lazy boundaries and are excluded on purpose —
   a lazy chunk is fetched when its surface is rendered, not at startup.
3. The transitive static closure of the entry chunk is the first-screen
   payload.

Build with `npx vite build --sourcemap` to also get per-chunk source
attribution.

## 2. Module-graph shape — `module-closure.mjs`

```powershell
node e2e/perf/agents/agent-e/module-closure.mjs
node e2e/perf/agents/agent-e/module-closure.mjs "--exclude=components/settings/SettingsView.tsx"
```

Walks the `packages/ui/src` import graph from a set of entry views and
reports, per entry, the transitive first-party module count and the
third-party packages it pulls in.

`--exclude=<view paths>` models a lazy boundary: the listed views become
leaves, exactly like `React.lazy(() => import(...))`, and the script prints
how many modules leave the eager graph.

## 3. `startup.typeable_ms` — `startup-typeable.mjs`

```powershell
node e2e/perf/agents/agent-e/startup-typeable.mjs --samples 5
node e2e/perf/agents/agent-e/startup-typeable.mjs --samples 5 --json e2e/perf/agents/agent-e/after.json
```

Launches the real Electron app in **preview mode**
(`DUYA_PREVIEW_MODE=true`), so the renderer loads
`file://<cwd>/dist/index.html` from THIS checkout — never a Vite dev server
on port 3000-3005, which on this machine usually belongs to another
worktree.

Per sample it reports:

| metric | meaning |
| --- | --- |
| `startup.typeable_ms` | launch call -> composer accepts a keystroke |
| `startup_firstPaint_ms` | launch call -> first contentful paint |
| `scriptDurationMs` | CDP `Performance.getMetrics` ScriptDuration |
| `jsBytesFetched` | JS bytes the renderer fetched for the first screen |

The profile is seeded by one **unmeasured** launch: `WelcomeView` renders
`<MessageInput disabled={!isHydrated || !selectedProject}>`, so a profile
without a project has a permanently disabled composer and "typeable" would
never be reachable. The seed launch adds one recent folder so the measured
launches behave like a returning user's.

## Measurement lock

Five agents benchmark this machine at once. Take the lock before building
or measuring:

```powershell
node E:\Projects\duya\.claude\perf-bench-lock.mjs acquire agentE-uiarch
node E:\Projects\duya\.claude\perf-bench-lock.mjs release
```
