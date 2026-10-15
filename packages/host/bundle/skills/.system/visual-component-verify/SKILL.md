---
name: visual-component-verify
description: "Verify React/Electron component appearance with the real component, app styles, fixtures, and focused Playwright screenshots. Use when layout, states, or themes need visual acceptance and full-app Electron rendering is awkward. React/Electron 组件视觉验收时使用。"
---

# Visual Component Verify

Render the actual changed component in a temporary Vite page so its pixels come
from the same React component and app styles as the shipped UI. Use mock data at
the component boundary to make important states easy to reproduce.

This verifies browser-rendered component appearance. It does not prove the
Electron main-process or IPC round trip; verify those separately when they are
part of the change.

## Workflow

### 1. Check the project and available tools

- Follow the repository's instructions and active plan. Check whether a working
  Storybook or configured browser tool already gives a focused view of the
  component.
- Check for an installed Playwright package and a cached browser before
  installing anything. Reuse the project's existing versions.
- Check for an existing preview harness, Vite server, and screenshot directory.
  Reuse a suitable harness. Do not overwrite another task's files or assume a
  port belongs to this project.
- Do not add dependencies, scripts, or Vite configuration just for a temporary
  preview.

### 2. Choose realistic, deterministic fixtures

- Import the real component, its real child components, and the app's real
  global stylesheet. Do not recreate the component in standalone HTML.
- Use fixed fixture data. Cover the visual states affected by the change:
  normal, empty, long or clipped content, selected/expanded, disabled, hover or
  focus, and light/dark themes as applicable.
- Prefer the component's real store or state entry point when it is practical.
  Seed again after mount if asynchronous hydration can overwrite the initial
  fixture.
- For preload or IPC-dependent components, stub only the bridge boundary.
  Match the shapes the component consumes: list calls return arrays, reads
  return objects, and event subscriptions return an unsubscribe function.
  Capture write arguments and assert them when serialization or saved fields
  matter.
- If using a generic Proxy bridge, put per-method overrides in its get trap;
  assigning properties to the Proxy target may have no effect. Make callable
  methods return unsubscribe functions where required. If the component awaits
  a namespace, keep that namespace non-thenable. Avoid stubs that return
  undefined for values the component iterates.

### 3. Create a throwaway Vite entry

Use a unique root HTML file and a small entry under src/dev. Vite serves root
HTML entries without a project config change.

~~~html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Component preview</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/dev/<name>-preview.tsx"></script>
  </body>
</html>
~~~

In the entry, import React, ReactDOM, the app's real global CSS, and the target
component. Set the theme on document.documentElement so :root[data-theme]
selectors work. Render the fixture in a minimal wrapper with the app's actual
theme tokens. Keep the harness limited to the target component and the minimum
providers it needs.

For a UI depending on asynchronous bridge callbacks, install the bridge stub
before mounting. Wait for React to mount, then seed or push fixture state again
if store hydration can race the first render. Wait for the target root before
capturing; page load alone does not mean React has mounted.

### 4. Capture and assert the rendered states

- Reuse a Vite server only after confirming the unique preview URL serves this
  project's harness. Otherwise start Vite on an available uncommon port with
  strict-port behavior; confirm the page responds before opening Playwright.
- Use the project's installed Playwright package and cached browser. Keep the
  viewport fixed and appropriate to the component.
- Capture the component locator, not the full app page, unless page-level
  overflow is what you are checking.
- Wait for the component root, perform the interaction, and read the resulting
  DOM state back before taking a screenshot. Assert theme, selected item,
  expanded state, or other visible state instead of assuming a click worked.
- Use a fresh screenshot path for each state. If a theme is important, confirm
  the document theme attribute and a computed token or sampled pixel; do not
  rely on a cached image preview.
- Listen for page errors and console errors. Investigate errors that can
  unmount or alter the component before accepting a screenshot.
- Measure relevant geometry with getBoundingClientRect when alignment, row
  height, clipping, or overflow is part of the change. Screenshots and geometry
  complement each other.
- Inspect the actual images with the available image/vision tool. If a
  reference was supplied, compare against it directly. Fix visible defects and
  repeat the capture.

Example Playwright capture:

~~~js
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1180, height: 780 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(error.message));

await page.goto('http://127.0.0.1:5199/<name>-preview.html');
await page.locator('.target-component-root').waitFor();
// Perform an interaction and assert its resulting DOM state here.
await page.locator('.target-component-root').screenshot({
  path: '<ignored-output>/<state>.png',
});
console.log({ errors });
await browser.close();
~~~

Adapt the import path and selectors to installed packages and the component.
Do not leave a script that assumes the example class or port exists.

### 5. Clean up and report

- Stop only the Vite process started for this capture.
- Remove only the exact harness files created for this task. If src/dev is
  shared, leave other files alone; remove the directory only if it is empty.
- Keep useful screenshots in a gitignored location. Check that the location is
  ignored before leaving screenshots in the repository.
- Report which component and states were captured, any geometry or console
  findings, and whether the result was only a component preview or also had
  Electron integration coverage.

## Common failure modes

- Setting data-theme on a wrapper does not activate :root[data-theme] CSS.
- Screenshotting immediately after page load can capture a blank React root.
- A generic async stub can return undefined where the component expects an
  array, object, or unsubscribe function and unmount the whole tree.
- Store hydration may overwrite a module-level fixture; seed after mount when
  needed and wait for the target to prove the fixture landed.
- A successful click is not evidence that the intended state is visible; assert
  aria state, selected index, class, or the component's own state marker.
- Reusing an output filename can make an image preview appear stale; use unique
  names and verify theme through DOM state or pixels.
- Screenshots do not prove loading, streaming, pagination, or main-process
  behavior over time.
