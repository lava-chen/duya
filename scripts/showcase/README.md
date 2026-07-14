# Duya Showcase Scripts

Generate the screenshots and demo GIF used in README.md, Show HN, Product Hunt,
and other launch channels.

## TL;DR

```bash
npm run showcase          # capture 5 PNGs
npm run showcase -- --gif # also compose demo.gif
```

Output goes to `assets/showcase/` (gitignored).

## What this is (and isn't)

This is a **lightweight, low-intrusion** screenshot driver for the real
Electron app. It spawns `electron .` with `--remote-debugging-port`,
attaches via Chrome DevTools Protocol (CDP), and captures the renderer
via `Page.captureScreenshot`.

It is **not** a Spectron / Playwright replacement and it does **not**
fake the UI. What you see in the PNG is exactly what a user sees when
they open the app.

## Stage status

| Scenario                        | Selector                                    | Status              |
| ------------------------------- | ------------------------------------------- | ------------------- |
| 01 launcher                     | `[data-showcase-ready="true"]`              | ✅ works today      |
| 02 research + browser tool card | `[data-tool-card-ready="browser.snapshot"]` | ⏳ needs Stage 2    |
| 03 local file edit              | `[data-tool-card-ready="edit.diff"]`        | ⏳ needs Stage 2    |
| 04 Conductor canvas             | `[data-conductor-ready="true"]`             | ⏳ needs Stage 2    |
| 05 permission prompt            | `[data-permission-open="true"]`             | ⏳ needs Stage 2    |

### Stage 1 (this commit)

- `showcase.mjs` orchestrates the 5 scenarios.
- `capture-electron.mjs` spawns Electron, waits for the renderer to mark
  itself ready, captures via CDP.
- `compose-gif.mjs` (optional `--gif`) stitches the PNGs into
  `assets/showcase/demo.gif` using `gifenc` + `pngjs`.
- The `DUYA_SHOWCASE` env switch is **not yet wired** into `main.ts`.
  Only scenario 01 produces a meaningful screenshot today; the others
  capture the launcher state and are labeled in `manifest.json`.

### Stage 2 (pending user approval)

To make scenarios 02..05 trigger real tool cards we need one small
addition to the Electron main process: when `DUYA_SHOWCASE=1`, skip
onboarding and feed fixture tasks from
`scripts/showcase/fixtures/tasks.json` into the agent worker.

This is intentionally **not** in Stage 1 so the change set stays
reviewable. Ask before authorizing.

## Files

```
scripts/showcase/
  showcase.mjs              # entrypoint
  capture-electron.mjs      # spawn + CDP capture
  compose-gif.mjs           # PNG → GIF
  fixtures/
    tasks.json              # mock tasks for Stage 2
  README.md                 # this file
  scenarios/                # (reserved for per-scenario logic later)
```

## Notes for future maintainers

- The capture script intentionally does **not** depend on `playwright`
  or `spectron`. Adding such a dep would bloat `node_modules` for what
  is a 30-line CDP wrapper.
- `compose-gif.mjs` requires `gifenc` and `pngjs`. Install with
  `npm i -D gifenc pngjs` before running `--gif`.
- Output is gitignored. If you want to commit specific frames for
  documentation, copy them into `docs/screenshots/` instead.