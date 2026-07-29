# Browser Navigation

Drive a real browser: navigate to URLs, click elements, scroll, and
manage tabs. This skill is the foundation every other Playwright skill
depends on — extract, fill, verify, and test all assume you can get to
the right page.

## When to use

- The user says "open this URL" / "go to ..." / "click on the X button".
- A downstream skill (`structured-extraction`, `form-operation`)
  needs to reach a page first.
- The user wants to verify a link works or a redirect behaves.

## Process

1. `browser_navigate` to the URL. Wait for the network to settle — the
   MCP server auto-waits for `load` by default.
2. `browser_snapshot` to capture the accessibility tree. The snapshot
   is the canonical way to identify elements for click/fill — do not
   hardcode selectors from raw HTML.
3. For clicks, prefer `browser_click` with a `ref` from the snapshot.
   Fallback to CSS selector only if the snapshot lacks the element.
4. For scroll, `browser_press_key` with `End` / `Home` / `PageDown`
   is faster than `browser_evaluate` scrolling.
5. For multi-tab flows, `browser_tabs` lists open tabs and switches
   between them. Do not assume a new tab opened — verify with a list.

## Tool call patterns

- `browser_snapshot` is cheap and idempotent. Take one before any
  interaction so you have a stable `ref` namespace.
- `browser_find` searches the page text. Use it to locate the
  clickable element when the snapshot is large.
- `browser_navigate_back` goes one step in history; do not navigate
  forward by re-entering the URL unless the page is stateful.

## Confirmation boundary

- Navigation, snapshots, finds, scrolling: `read` tier, automatic.
- Clicks on public pages: `write` tier, confirm — even a "harmless"
  click can trigger an OAuth flow or a destructive action.
- Navigation to `file://` or `localhost` dev servers: `read` tier,
  automatic — this is local-only.

## Pitfalls

- SPAs may not fire a `load` event after route changes. Take a fresh
  snapshot after any client-side navigation.
- `browser_click` on an element that moves during the click (e.g.
  sticky headers) can miss. Scroll the element into view first.
- Pop-ups and dialogs can intercept clicks. Handle with
  `browser_handle_dialog` before continuing.
