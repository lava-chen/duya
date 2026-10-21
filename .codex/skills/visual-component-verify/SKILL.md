---
name: visual-component-verify
description: Verify a React/UI component visually when the project has no working Storybook, by spinning up a throwaway Vite entry point and screenshotting it with an already-installed local Playwright. Use when a UI change needs real browser rendering (layout alignment, colors, hover/focus states, dark mode) that jsdom unit tests cannot validate, or when AGENTS.md/project rules require visual verification but no MCP browser tool is configured.
description_zh: "无 Storybook 时用临时 Vite 入口 + 本地 Playwright 对 UI 组件做视觉验证"
description_en: "Visually verify UI components via a throwaway Vite entry and local Playwright"
agent_created: true
---

# Visual Component Verify

Prove a UI change actually renders correctly, without installing a browser tool or
a Storybook. jsdom tests confirm *structure*; they cannot tell you that two columns
are misaligned by one pixel, that a highlight stops at a column boundary, or that a
text block is clipped mid-sentence.

## When to use

- A UI/layout change where "does it look right" is the actual acceptance criterion.
- Project rules demand visual verification (e.g. "verify with Playwright before
  submitting") but no browser MCP tool is connected.
- You need geometry numbers jsdom cannot produce: row alignment, node centering,
  element heights, cross-column band matching.

## Step 0 — Don't install anything yet

Check what already exists, in this order. Usually something already works.

```bash
# Is Storybook actually functional? Scaffolding dirs often survive `storybook init`
# while the scripts and devDependencies were never kept. Check for BOTH.
ls -d .storybook src/stories 2>/dev/null
node -e "const p=require('./package.json');const d={...p.devDependencies,...p.dependencies};
for(const k of Object.keys(d))if(/story/i.test(k))console.log(k,d[k]);
for(const[k,v]of Object.entries(p.scripts))if(/story/i.test(v))console.log(k,v)"
# No deps + no scripts => Storybook is dead scaffolding. Do not try to run it.

# Is Playwright already present with a downloaded browser?
ls -d node_modules/playwright node_modules/@playwright 2>/dev/null
ls ~/AppData/Local/ms-playwright 2>/dev/null        # Windows
ls ~/Library/Caches/ms-playwright 2>/dev/null       # macOS
```

If Playwright is installed **and** a browser is cached, you need to install nothing.
This is common in repos with an `e2e/` suite — the browser is already downloaded.

Fall back to installing `agent-browser` only if neither exists, and note that it
pulls ~500 MB of Chromium.

## Step 1 — Throwaway Vite entry

Vite's dev server serves any `.html` at the project root, so no config change is
needed. Create two files:

**`<name>-preview.html`** (repo root):
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Preview</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/dev/<name>-preview.tsx"></script>
  </body>
</html>
```

**`src/dev/<name>-preview.tsx`**:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/globals.css';           // the app's real design tokens
import { TheComponent } from '../components/...';

// Theme switching: prefer the app's real mechanism (attribute on <html>),
// because wrapper <div data-theme> will NOT match `:root[data-theme]` selectors.
const params = new URLSearchParams(window.location.search);
if (params.get('theme') === 'dark') {
  document.documentElement.dataset.theme = 'dark';
}

// Build a fixture that exercises every branch: long lists for truncation,
// multi-line text, plural items, the empty case.
const FIXTURE = [/* ... */];

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ padding: 24, background: 'var(--main-bg)', minHeight: '100vh' }}>
      <TheComponent {...FIXTURE} />
    </div>
  </React.StrictMode>,
);
```

Alias note: if the project uses a `@/` path alias, Vite resolves it in both the
harness and the component — but relative imports into the real tree are simpler
and avoid depending on alias config.

**No `vi.mock` in a browser harness — drive the real wiring instead.** Where a unit
test would stub a hook, feed the module the real thing: push events through the
project's own store / session-manager entry point (TS `private` is compile-time only,
so `(manager as unknown as { hiddenFn: ... }).hiddenFn(...)` works at runtime), or
satisfy the preload callbacks the hook subscribes to (`onXUpdate(cb)` → call `cb` with
a fixture on the next tick). This is strictly better evidence than a mock demo: the
harness exercises the same projection the shipped code uses, and it also proves the
subscription wiring (one flag: hooks that subscribe *after* mount may need the fixture
pushed again from the script, e.g. via a `window.__setX(n)` you expose).

## Step 2 — Run the dev server in the background

**First check whether the repo already has one up** — a previous session often leaves
a Vite on a harness port, and `--strictPort` then fails with `Port 5199 is already in
use` (which reads like a bug but is not):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5199/<name>-preview.html
```

A `200` means that server is rooted at this repo (Vite serves new root-level `.html`
files without a restart) — reuse it, do not start a second one.

Otherwise:

```bash
npx --no-install vite --port 5199 --strictPort
```

Pick an uncommon port and use `--strictPort` so it fails loudly instead of
silently moving. Then confirm it is actually up before screenshotting:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5199/<name>-preview.html
```

## Step 3 — Screenshot AND measure

The screenshot shows the eye test; `page.evaluate` produces the numbers. Do both —
the measurements are what catch the bugs the eye forgives.

```js
import { chromium } from 'playwright';

const browser = await chromium.launch();
const errors = [];

async function shoot(theme, name, act) {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 780 },
    deviceScaleFactor: 2,          // retina-quality output
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${name}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));

  await page.goto(theme === 'dark' ? BASE + '?theme=dark' : BASE, { waitUntil: 'load' });
  await page.waitForSelector('.the-root-class');   // never screenshot before mount
  if (act) await act(page);                       // hover / click / scroll
  await page.waitForTimeout(350);                 // let transitions settle

  await page.locator('.the-root-class').screenshot({ path: `${OUT}/${name}.png` });

  // Geometry that unit tests cannot see:
  console.log(await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.row')];
    const boxes = rows.map((r) => r.getBoundingClientRect());
    return {
      rowCount: rows.length,
      rowTops: boxes.map((b) => Math.round(b.top - boxes[0].top)),
      rowHeight: boxes[1] ? Math.round(boxes[1].top - boxes[0].top) : null,
      bodyScrollW: document.body.scrollWidth,   // > viewport => horizontal overflow
    };
  }));
  await page.close();
}
await browser.close();
console.log(errors.length ? errors.join('\n') : '(no console errors)');
```

Screenshot states worth capturing: default, hover/focus, expanded/selected, and
**both themes** — dark-mode bugs are invisible in a light-only check.

## Step 3b — Make the capture assert, never assume

`click()` then `screenshot()` is not enough. In practice a shot silently came back
showing a *different* row and *light* theme than the script intended — and a lying
screenshot is worse than no screenshot, because you will review it and draw the
wrong conclusion.

Read the state back from the DOM and **throw** if it is not what you asked for:

```js
const selectRow = async (index) => {
  await page.locator('.row').nth(index).click();
  await page.waitForTimeout(220);
  const actual = await page.evaluate(() =>
    [...document.querySelectorAll('.row')].findIndex((r) => r.className.includes('is-selected')));
  if (actual !== index) throw new Error(`selectRow(${index}) landed on ${actual}`);
};

const setThemeAndCheck = async (expected) => {
  await page.getByRole('button', { name: /theme:/ }).click();
  await page.waitForTimeout(250);
  const actual = await page.evaluate(() => document.documentElement.dataset.theme);
  if (actual !== expected) throw new Error(`theme is ${actual}, expected ${expected}`);
};
```

Any state a human would judge the shot by — theme, selection, expansion, viewport —
gets an assertion. This also turns "the harness drifted" into a loud failure instead
of a plausible-looking wrong picture.

### Verify theme by pixel, not by eye

Reading the PNG back can serve a **cached image for the same path**, so a fresh dark
screenshot may display the previous light one. Do not judge theme from the rendered
image alone. Either write to a brand-new filename, or sample real pixels — decode the
screenshot buffer in the page and print RGB:

```js
const buf = await page.screenshot({ clip });
const px = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  const at = (x, y) => [...c.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3).join(',');
  return { topLeft: at(4, 4), body: at(700, 300) };
}, buf.toString('base64'));
```

For this project that returned `255,255,255` / `247,247,247` (light) versus
`30,30,30` / `43,43,43` (dark) — unambiguous, and immune to any image cache.
`getComputedStyle(document.documentElement).getPropertyValue('--main-bg')` works too
when the theme is driven by CSS custom properties.

## Step 4 — Delete the harness

The harness is scaffolding, not a deliverable. Remove all three artifacts and the
file list must come back empty:

```bash
rm -f <name>-preview.html src/dev/<name>-preview.tsx _shot.mjs
rmdir src/dev 2>/dev/null   # only if you created it and it is now empty
```

**Never `rm -rf src/dev` (or any shared scratch dir) in a repo with parallel
sessions.** `src/dev/` is the conventional drop point, so other agents' harnesses
(`composer-status-row-preview.tsx`, …) live there too — and they may be created
*after* you started. Delete your own file, then `rmdir` only if the directory is
empty; re-`ls` it right before you remove anything.

Screenshots you want to keep should live somewhere gitignored (e.g. a scratch dir
covered by `.gitignore`) so they do not pollute the diff.

## Assumptions and limits

- **Check `src/dev/` for an existing harness first.** Repos accumulate them (one per
  past verification). Copy its IPC stub verbatim — squashing the stub pitfalls below
  is most of the work. Delete only the harness *you* added.
- **A module-scope `data-theme` write can read back unset.** The harness sets it at
  module eval, but `waitForSelector`-then-read has been seen returning nothing for an
  identical URL that worked on the previous case. Read the attribute from the DOM,
  **re-apply it if it is not what you asked for**, push a note into the error list, and
  keep the pixel assertion as the real gate (a re-applied light screenshot is still
  caught by `lum > 160`).
  - **Put the per-namespace overrides in the `get` trap, not on the target.** A
    natural-looking `const api = makeStub(); api.thread = { list: async () => [] }`
    **does nothing**: the trap answers every string key with a fresh stub and never
    consults the target, so the override is invisible and you get the bare
    `undefined` you were trying to avoid. Give the factory an `overrides` map and
    return `overrides[prop]` when it `hasOwnProperty`. Two symptoms this masks:
    `setBots(undefined)` → later `for (const bot of bots)` ⇒ **`bots is not
    iterable`** pageerror that unmounts the tree, and `raw.map is not a function`
    for list reads. For "feature-detect then call" code
    (`if (!api?.projects?.getRecentFolders) return`), the stub is *always* truthy —
    override that key with `null` to force the early-return branch.
- **Preload/IPC-dependent components: stub the bridge, don't skip them.** Assign a
  plain object to `window.<bridge>` in the harness *before* render — the component
  only ever reads it, so a fixture object is enough for every visual state (light /
  dark / empty / dirty). What you cannot exercise is the real main-process round
  trip; say that explicitly instead of claiming the feature was verified end to end.
  - **Make the stub callable AND awaitable.** A stub whose methods return
    `Promise.resolve(undefined)` looks fine until the component does
    `const off = onSomething(cb); return () => off()` → `off is not a function`,
    which throws during mount and leaves an **empty page** (no error boundary ⇒ React
    unmounts the whole tree, `#root` is blank, and the selector wait just times out).
    Use a function target with a non-enumerable `then` that resolves, and return a
    fresh stub from every `get` (return `undefined` for symbol keys and for `then`
    when you need a non-thenable namespace):
    ```js
    const makeStub = () => {
      const fn = () => makeStub();
      Object.defineProperty(fn, 'then', { value: (r) => Promise.resolve(undefined).then(r) });
      return new Proxy(fn, { get: (t, p) => (p === 'then' ? t.then : typeof p === 'symbol' ? undefined : makeStub()) });
    };
    ```
  - **Whatever the hooks iterate must resolve to an array/object.** `await listBots()`
    → `undefined` → `setBots(undefined)` → later `for (const b of bots)` ⇒
    `bots is not iterable`, again unmounting the tree. Override the handful of real
    namespaces the subtree reads (`settingsDb.getAll/getJson/setJson`,
    `configAgents.list`, `groups.list`, …) with plausible empties and let the rest
    fall through to the generic stub. Expect a few caught `console.error`s from list
    reads you left stubbed — filter them out of the "no console errors" assertion
    instead of chasing them.
  - **Seed store state from the script, not just the module.** App stores hydrate
    themselves on mount and mirror through `BroadcastChannel`/localStorage, which can
    land *after* a module-level seed and wipe it. A wiped list-backed element (e.g. a
    section that renders `null` when its list is empty) then vanishes for the rest of
    the run — a 30 s locator timeout that looks like a bad selector. Expose the seed
    as `window.__seed(...)` and re-apply it from Playwright after mount, then
    `waitForSelector` the target to prove it landed. Keep counters/expand state in the
    component above the seeded list so re-seeding doesn't reset the UI state you are
    testing.
- **Record the payload on the way out.** Make the stubbed write path capture its
  argument (`save: async (p) => { window.__lastSave = p; return { ok: true } }`),
  then assert on it after clicking Save. This is how you catch a metadata editor
  that silently drops one field or fails to serialize a nested shape — a bug no
  screenshot will show you, because the UI *looks* fine either way.
- Screenshots do not prove behaviour over time (loading, pagination, streaming).
- `deviceScaleFactor: 2` inflates the PNG; drop it for very tall pages.

## Pitfalls

- **A real app subtree remounts; a bare `page.evaluate` races it.** With React
  StrictMode (and any async store hydration) the tree can unmount/remount right after
  a click, so `document.querySelector(...)` intermittently returns `null` —
  `Cannot read properties of null (reading 'dataset')` — and `getAttribute` on a tab
  it just clicked can read the *previous* value. Wrap every DOM read in a short
  retry (`for i<6 { try { return await page.evaluate(fn) } catch { await wait(250) } }`)
  and re-click + re-assert toggles (`aria-selected === 'true'`) in a loop. Verify the
  end state, never the act.
- **`getByRole('menuitem')` often finds nothing.** Custom menu components frequently
  put `role="menu"` on the wrapper and leave the item `<button>`s role-less, so the
  computed role stays `button` and the locator times out. Query by the item's own
  class or its text instead (`.some-menu-item` with `hasText`), and assert the count
  before clicking so a selector drift fails loudly rather than silently skipping.
- **`waitForSelector` before screenshotting.** Screenshotting on `load` frequently
  captures a blank frame for a React app.
- **`:root[data-theme]` cannot be faked by a wrapper element.** Set the attribute on
  `document.documentElement`.
- **Enumerate the live states, not just the pretty one.** Hover, selected, disabled,
  overflow/truncated, and empty are where UI bugs actually live.
- **Prefer `locator(...).screenshot()` over full-page** to get a clean component
  frame; use `fullPage: true` only when vertical overflow itself is the subject.
  Note that a `clip` box computed once at start goes stale if the component's height
  changes with state (e.g. a collapsed detail strip) — recompute it per shot.
- **Read tool image cache**: re-reading the same PNG path after a re-run can return
  the *previous* image, sometimes even flagged as "identical to the earlier result".
  Treat a suspicious image as unverified and fall back to pixel sampling or
  computed styles.
- **Parallel `Edit` calls to the same file lose one edit.** If you add an import in
  one call and an export in another, in the same message, only one may land — and
  the typecheck error (`Cannot find name 'X'`) looks like a code bug, not a tool
  race. Serialise edits per file; parallelise only across files.
- **Components that render a trailing `<style>` break "is it the last child" assertions.**
  E.g. duya's `ContextUsageRing` returns `<>…<style>{…}</style></>`, so
  `row.lastElementChild` is the style tag, not the component — a naive assertion
  fails on every state and looks like a layout bug. Filter out `STYLE`/`SCRIPT`
  children (or query for the component's root class) before asserting ordering.
- If a background dev server is used, stop it when finished — leaving it bound to a
  port breaks later runs.
