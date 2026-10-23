# Agent D — GPU / Electron observability harness

Measures the GPU-side rendering behaviour of the Desktop app under three GPU
states, and produces the `gpu.compositing` observation the main process was
missing.

## What it measures

| Metric | Meaning | Where it comes from |
| --- | --- | --- |
| `frame.p95_ms` | p95 of the interval between adjacent `requestAnimationFrame` callbacks — the frame cadence the user sees | renderer, `requestAnimationFrame` loop |
| `frame.p50_ms` / `frame.mean_ms` / `frame.max_ms` | the rest of the distribution, so a bimodal one is visible | same |
| `longtask.count` | number of `longtask` entries (>50ms of main-thread blocking) | renderer, `PerformanceObserver` |
| `longtask.total_ms` | total main-thread blocking time | same |
| `gpu.compositing` | how the window is composited | main process, `app.getGPUFeatureStatus()` |
| `gpuProcessExitCount` | how many times the GPU process died | main process, `child-process-gone` |
| `webglContextLossCount` | how many WebGL contexts the renderer reported as lost | main process, via the preload bridge |

Frame cadence and main-thread blocking are reported **separately**. A frame
interval says how often the screen updated; a long task says how long the main
thread was blocked. A GPU problem shows up in the first, a React/JS problem in
the second, and merging the two hides the distinction this harness exists to
make.

## The three GPU states

| Mode | How it is produced | Changes the product? |
| --- | --- | --- |
| `gpu-normal` | the app as shipped | no |
| `gpu-unavailable` | `--disable-gpu` launch switch | no — a launch switch, not a product setting |
| `webgl-context-lost` | `WEBGL_lose_context` on the terminal's canvas at runtime | no — the product's own degradation path |

## Running it

The app must be built first (the harness drives the real main process):

```powershell
npm run build:packages
npm run build:electron
npx vite build
```

Then:

```powershell
node e2e/perf/agents/agent-d/gpu-observability.mjs --mode gpu-normal
node e2e/perf/agents/agent-d/gpu-observability.mjs --mode all --repeats 3
```

Results land in `e2e/perf/agents/agent-d/results/` (git-ignored).

### Measurement lock

Every agent in the performance sprint shares one machine. Take the lock before
a run and release it right after, so a run is not measuring another agent's
build:

```powershell
node e2e/perf/agents/agent-d/run-with-lock.mjs -- --mode all --repeats 3
```

`acquire` exits `0` when the lock is yours and `2` when another agent holds it.

The lock script lives outside the repository, so its path is resolved in this
order:

| Source | Example |
| --- | --- |
| `--lock-script <path>` | `--lock-script E:\Projects\duya\.claude\perf-bench-lock.mjs` |
| `--lock <path>` | legacy alias for the flag above |
| `DUYA_PERF_LOCK_SCRIPT` | `$env:DUYA_PERF_LOCK_SCRIPT = '<path>'` |
| `DUYA_PERF_BENCH_LOCK` | legacy alias for the variable above |
| repository-relative candidates | `<repo>/.claude/perf-bench-lock.mjs`, `<repo>/perf-bench-lock.mjs`, `<repo>/../perf-bench-lock.mjs`, `<repo>/../../perf-bench-lock.mjs` |

When none of them exists the run still happens: the wrapper prints a warning
that the numbers are 未持锁测量 (taken without the lock) and the result file
records `lock.enabled = false` with the reason.

## Why this is not a Playwright test

`e2e/playwright.config.ts` collects the `smoke`, `ipc`, `turn` and `ui-states`
projects. A performance harness inside `npm test` would run on every
contributor's machine and pollute every other agent's baseline, so this
directory is deliberately not part of any project.
