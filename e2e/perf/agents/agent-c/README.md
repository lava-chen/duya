# Agent C — React state-update measurement

Measures what the **sidebar** does while the user types, and how much of the
app re-renders as a side effect. Owned by Agent C; nothing outside this
directory is touched.

## Files

| File | Purpose |
| --- | --- |
| `probe.js` | In-page probe: frame intervals, keystroke→painted-frame latency, DOM mutation batches, long tasks, and fiber-level re-render detection. |
| `measure.mjs` | Runner: launches the real Electron app in preview mode, drives the composer, prints the report. |
| `screenshot.mjs` | Captures the sidebar (default view + the Work tab) so a change can be compared visually before and after. |

## Prerequisites

The renderer must be built from THIS checkout — the runner loads
`dist/index.html` over `file://`, never a dev server on port 3000 (another
worktree may hold that port, and the measurement would then describe someone
else's code).

```powershell
npm run build:packages      # @duya/* dist, needed by the renderer
npm run build:electron      # main + preload
npx vite build              # renderer
```

## Run

```powershell
node e2e/perf/agents/agent-c/measure.mjs --scenario draft --chars 60
node e2e/perf/agents/agent-c/measure.mjs --scenario draft --chars 60 --repeats 3 --out draft.json
node e2e/perf/agents/agent-c/screenshot.mjs --out after.png
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--scenario draft\|home` | `draft` | Which composer to type into. `draft` = the lazy new-chat composer, whose draft is persisted to the conversation store on every keystroke. `home` = the welcome-screen composer (local state only). |
| `--chars N` | 60 | Characters to type. |
| `--interval MS` | 50 | Delay between keystrokes. |
| `--repeats N` | 1 | Repeats; each run is reported separately plus the median. |
| `--out FILE` | — | Write the raw JSON report. |
| `--no-lock` | off | Skip the shared benchmark lock (only when the caller already holds it). |
| `--user-data DIR` | — | Reuse a fixed Electron profile directory instead of a fresh one. |
| `--namespace NAME` | — | Reuse a fixed `--duya-namespace` value (the Host resolves its own database from the namespace config root). |

The runner **takes the shared benchmark lock** (`E:\Projects\duya\.claude\perf-bench-lock.mjs`)
for the whole run and releases it afterwards, so the numbers are not taken
while another agent is building or measuring. Set `DUYA_PERF_LOCK` to point
at a different lock script.

## What the numbers mean

| Field | Source |
| --- | --- |
| `interact.p50_ms` / `interact.p95_ms` | keystroke → next painted frame. |
| `frame.p50_ms` / `frame.p95_ms` | adjacent `requestAnimationFrame` intervals. |
| `commit.count` | **MutationObserver change batches.** The production build ships no React Profiler, so per the plan's metric contract this is the honest substitute. |
| `dom.mutations` | MutationObserver `childList` changes. |
| `dom.nodes` | `document.getElementsByTagName('*').length`. |
| `longtask.count` / `longtask.total_ms` | `PerformanceObserver` longtask. |
| `renders.total` / `renders.app` / `renders.sidebar` | React fibers that re-rendered, counted by walking `__reactFiber$` from the DOM. A re-render that produces identical DOM leaves no mutation behind, so this is the only way to see wasted work. |

`renders.sidebar` is the number that answers "did an unrelated region
re-render while I typed": it counts the fibers under `.app-sidebar-column`.

## Known limitation — the sidebar is empty in the default fixture

A fresh profile has no project groups and no sessions, so the sidebar tree
is two orders of magnitude smaller than a real one. `renders.sidebar` still
measures the thing the change is about (how often the sidebar re-renders
while the user types), but `frame.p95_ms` and `interact.p95_ms` cannot move
on that fixture: there is almost nothing to render. A populated fixture
(`perf/session-100`) was attempted through the app's own `db:session:create`
IPC; the created rows are not visible to a later run, because the sidebar
reads the session list from the Host session store rather than from the
legacy table that IPC writes to. That fixture is therefore NOT reproducible
with the current harness, and no number in the report is based on it.
