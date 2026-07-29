# Visual Comparison

Compare the rendered implementation against the Figma source of
truth. Use this skill after `component-implementation` to close the
loop — extract a screenshot from Figma, capture a screenshot of the
local render, and surface the deltas the user needs to reconcile
with the designer.

## When to use

- The user says "does my implementation match the design?" / "what
  changed between the Figma and the code?".
- After `component-implementation` writes the code, before reporting
  the work as done.
- A designer reports that a shipped screen "doesn't look right" and
  you need to identify the specific deltas.

## Process

1. Confirm the Figma node and the local URL to compare. The local
   URL may be a dev server (`http://localhost:3000/...`), a
   Storybook story, or a static HTML file.
2. Call `figma.get_image` on the Figma node with `format=png` and a
   scale that matches the local viewport (commonly `2x` for retina).
   Store the screenshot in a temp path; do not commit it to the
   repo.
3. Use the Playwright plugin (`playwright-web-operator`) or the
   built-in browser tools to navigate to the local URL and capture a
   screenshot at the same viewport size. If the Playwright plugin is
   not installed, fall back to the user-provided screenshot.
4. Place the two screenshots side by side in chat. Surface the
   obvious deltas first:
   - Layout shifts (alignment, spacing, sizing).
   - Color deltas (token mismatch or hard-coded color).
   - Typography deltas (font family, weight, size, line-height).
   - Missing or extra elements (icons, badges, copy).
5. For each delta, classify it as:
   - **Code bug** — implementation diverges from the agreed mapping.
     Fix in `component-implementation`.
   - **Token gap** — design uses a token not present in the code
     system. Resolve with the designer.
   - **Design bug** — Figma itself is inconsistent (e.g. a primary
     button rendered with a secondary color). Flag for the designer.
   - **Acceptable drift** — minor sub-pixel or anti-aliasing
     differences that don't need action.
6. Report the deltas as a checklist with the recommended next step.
   Do not auto-fix without the user's confirmation.

## Tool call patterns

- `figma.get_image(file_key, node_id, format="png", scale=2)` is the
  canonical screenshot source. Use the same `scale` for both sides
  to avoid sub-pixel false positives.
- For the local side, `browser.navigate` + `browser.take_screenshot`
  from the Playwright plugin gives a real render. Set the viewport
  explicitly before navigating — SPAs may render before layout
  settles.
- For diffing, do not rely on pixel-perfect equality — anti-aliasing
  and font rendering across OSes will always produce false
  positives. Focus on structural deltas a human reviewer would
  notice.

## Confirmation boundary

- Reading Figma and capturing local screenshots: `read` tier,
  automatic.
- Navigating the local browser: `read` tier, automatic (it is a
  dev server or local file).
- Auto-fixing deltas by editing code: hand off to
  `component-implementation` and follow its `write` / `modify`
  confirmation rules. Do not edit code directly from this skill.

## Pitfalls

- Figma renders with its own font stack (Inter by default). If the
  code uses a different font, the typography deltas will dominate
  the report. Confirm the font mapping before reporting.
- `figma.get_image` clips to the node bounds. If the implementation
  overflows, the comparison will look misaligned without
  explanation. Capture the full-page screenshot on the code side
  and compare structural regions, not just the bounding box.
- Auto-layout padding in Figma is interior; CSS padding is also
  interior, but border and box-sizing differences can shift content.
  Verify `box-sizing: border-box` on the implementation.
- Dark mode: capture both light and dark if the design has both,
  otherwise the comparison will report false color deltas.
