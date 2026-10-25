# Agent E — UI package architecture (first-screen payload)

Measurement scripts for the shared renderer (`packages/ui`), used by the
Duya Desktop performance hill-climb plan
(`docs/exec-plans/active/2026-10-23-desktop-performance-hill-climbing.md`).

They deliberately import nothing from `packages/` — `e2e/` must not depend on
product packages — and they reuse the shared harness in `e2e/perf/lib/` and
`e2e/perf/scenarios/` rather than re-implementing it.

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

Only `dist/assets/*.js` is counted, so nothing else in `dist/` can inflate
the number.

`--chunk-dump <path>` points the script at a Rollup chunk-graph dump
(`imports` / `dynamicImports` / module ids per chunk). It is optional: the
dump comes from a throwaway Rollup plugin that writes **outside** `dist/`, so
the measurement never adds a byte to the shipped bundle. Without it the
graph is derived from the emitted chunks, and the two agree on the
first-screen closure.

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

## 3. `startup.typeable_ms` — `startup-measure.mjs`

```powershell
node e2e/perf/agents/agent-e/startup-measure.mjs --samples 5 --label after
node e2e/perf/agents/agent-e/startup-measure.mjs --samples 5 --label before --build=renderer
```

This is the shared startup scenario
(`e2e/perf/scenarios/startup.mjs`) with two additions:

- the **build** can happen inside the same lock as the measurement, so a
  build that races another agent's measurement does not produce a number
  that belongs to neither build;
- the first-screen payload is measured from the same build and written into
  the same report.

It launches the real Electron app in **preview mode**
(`DUYA_PREVIEW_MODE=true`), so the renderer loads
`file://<cwd>/dist/index.html` from THIS checkout — never a Vite dev server
on port 3000-3005, which on this machine usually belongs to another
worktree.

| metric | meaning |
| --- | --- |
| `startup.typeable_ms` | process start -> composer accepts a keystroke |
| `startup.firstPaint_ms` | process start -> first contentful paint |
| `startup.warm.*` | the same boot on a profile prepared through the product's IPC |
| `startup.reload.*` | the same boot path observed from inside the document |

The profile is seeded by one **unmeasured** launch: `WelcomeView` renders
`<MessageInput disabled={!isHydrated || !selectedProject}>`, so a profile
without a project has a permanently disabled composer and "typeable" would
never be reachable. The seed launch adds one project and one session so the
measured launches behave like a returning user's.

## Measurement lock

Five agents benchmark this machine at once. A number taken while another
agent builds or measures is a measurement of contention, so the runner takes
the shared lock (`e2e/perf/lib/lock.mjs`) around the build and the
measurement:

```powershell
node e2e/perf/agents/agent-e/startup-measure.mjs --samples 5 --label after
```

`--lock-wait-ms N` sets how long to wait for the lock, and
`--best-effort` measures without it — the report then records
`lock.held: false` and the reason, so a contaminated number is visible
rather than silently presented as clean.
