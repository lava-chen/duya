# Frontend Verification

Verify a local page renders and behaves correctly. This skill is the
bridge between the AGENTS.md Playwright verification gate and chat —
it turns "verify the UI" from a manual checklist into a reproducible
script.

## When to use

- AGENTS.md mandates UI changes be verified with Playwright MCP. This
  skill is the canonical path.
- The user says "does the new layout look right?" / "verify the modal
  opens" / "check dark mode".
- A frontend change was just made and you need to confirm before
  committing.

## Process

1. Confirm the Vite dev server is running on `localhost:3000` (or the
   project's configured port). If not, start it with `npm run dev` in
   a non-blocking terminal.
2. `browser_navigate` to the changed route.
3. `browser_take_screenshot` for a visual baseline. Compare to the
   expected layout — describe what you see in chat.
4. `browser_snapshot` for the accessibility tree. Verify the expected
   elements are present and in the right order.
5. For interactive changes, drive the interaction:
   - Click the trigger (`browser_click`).
   - Take a snapshot of the resulting state.
   - Assert the expected outcome (e.g. modal visible, route changed,
     class added).
6. For theme verification, toggle `data-theme` via
   `browser_evaluate` and re-screenshot. AGENTS.md requires both
   light and dark mode support.
7. Report findings: pass / fail per assertion, with screenshots
   attached. If any assertion failed, do not commit the change.

## Tool call patterns

- `browser_take_screenshot` accepts a `fullPage` flag. Use it for
  layout verification; use a viewport-scoped screenshot for component
  verification.
- `browser_evaluate` can read `getComputedStyle(el).color` etc. to
  verify CSS variables resolved correctly.
- `browser_console_messages` after navigation catches render errors
  that the screenshot does not show.

## Confirmation boundary

- Navigation to `localhost`, `127.0.0.1`, and `file://`: `read`
  tier, automatic — local-only.
- Clicks on local UI elements: `read` tier, automatic — these are
  local state mutations.
- Taking screenshots, snapshots, reading console: `read` tier,
  automatic.

## Pitfalls

- Vite HMR can leave stale state. Refresh the page after a code
  change before verifying.
- Dark mode may require a toggle click — verify the toggle persists
  state to localStorage, otherwise the next navigation resets it.
- Console errors during render are blocking even if the screenshot
  looks fine. Always check `browser_console_messages`.
- Do not commit UI changes that fail this skill. AGENTS.md is
  explicit: "Do not skip" Playwright verification for UI changes.
