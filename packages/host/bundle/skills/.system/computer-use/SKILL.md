---
name: computer-use
title: computer-use — Windows system-level computer control (CUA 14-tool surface)
description: "Use when a task needs a native desktop app's own UI or the OS on Windows: read a window's accessibility tree with get_app_state, act on element indices (left_click / set_value / perform_action / select_text ride UIA patterns on background windows), or send global input (type / key / scroll / paste). Aligned with the ZCode/Codex 14-tool CUA surface. For anything inside a web page, use Browser Use instead. Main agent only — never delegate to a subagent."
when-to-use: "The task target lives in a native desktop app or the OS layer (File Explorer, Settings, custom-drawn GUI programs, Electron window chrome). In-page web actions go to Browser Use; pure visual-fallback screenshots go to computer_use capture/click."
---

# Windows system-level computer control (computer_cua)

`computer_cua` is the ZCode/Codex-aligned 14-tool surface (plan 575):
accessibility-first, window-scoped, receipt-grade. Core loop: **observe once →
act on element indices → observe again to confirm**.

## Tools (values of the `tool` argument)

Observation:
- `list_apps` — running apps (pid / exe / title / active). Only lists apps
  with a **visible** main window; minimized apps come through `list_windows`
  rows carrying `minimized: true`
- `list_windows` — top-level windows (windowId / pid / title / bounds /
  minimized / cloaked), **including minimized windows**
- `get_app_state` — core: read a window's indexed element tree by app_ref.
  Minimized windows are addressable (the tree reads fine). `includeScreenshot: true`
  attaches a window screenshot and **arms coordinate clicks**; on a minimized
  target it **first restores the window WITHOUT stealing the user's focus**,
  re-queries the rect, then captures — element bounds and pixels share one
  post-restore layout. Visible targets are never restored. Unchanged windows
  return a delta (changes only)
- `request_access` — readiness check (Windows has no TCC; UIPI note)

Actions (element targets ride UIA patterns — work on background windows,
re-verified after dispatch):
- `left_click` — element target → pattern chain (auto); coordinate target → real cursor
- `set_value` — ValuePattern write (bypasses IME; first choice for CJK text)
- `perform_action` — dispatch a semantic action the element advertises (the
  actions=[...] rows: AXPress / AXToggle / AXExpand / AXCollapse / AXSelect /
  AXSetValue / AXShowMenu)
- `select_text` — TextPattern locate-and-select inside an element
- `type` / `key` / `paste` / `scroll` / `left_click_drag` — global input
- `stop_computer_control` — drop all observation state for this session
  (kill switch / session change)

## Iron rules

1. **Accessibility first**. Click `[n]` over coordinates whenever an element
   row exists; `set_value` over `type` whenever the field accepts it.
   Coordinates are the last resort — and require a frame from a prior
   `get_app_state(includeScreenshot=true)`.
2. **An action is not an effect**. The coordinate path of `left_click`
   returns `dispatch_status: possibly_sent`; the element path returns
   `target_verification_status`. On possibly_sent / mismatched /
   unavailable, **re-observe FIRST, then decide** — never blindly re-issue a
   non-idempotent action.
3. **Indices are session-scoped**. `[n]` binds to your LAST `get_app_state`
   observation + its app_ref (pid/name/windowId). After navigation, or on
   ELEMENT_UNAVAILABLE / STALE_STATE, re-observe for a fresh tree.
4. **Error classes are action instructions**:
   - `ELEMENT_UNAVAILABLE` / `STALE_STATE` → reobserve (get_app_state again)
   - `ACTION_UNAVAILABLE` / `NOT_SETTABLE` / `NOT_SELECTABLE` → change method
     (e.g. coordinate click or the visual fallback)
   - `PERMISSION_DENIED` (UIPI — the target window runs elevated) → stop and tell the user
   - `CONTROLLER_BUSY` / `NOT_AUTHORIZED` → never retry; report and stop
   - a failure carrying `action_sent: true` → the action may have landed;
     observe only, never replay
5. **An empty tree is not a failure signal**. Custom-drawn windows (games,
   some browser content) yield an empty tree: fall back to the `computer_use`
   vision loop (capture somMode=true → click) instead of retrying.

## Switching apps

- Target any app by name / pid / windowId — **no app ever needs the foreground**.
- Minimized windows: `get_app_state` reads the tree directly; for pixels add
  `includeScreenshot: true` (auto-restores without stealing focus).
- **A not-running app cannot be observed**: launch it via the Bash tool first
  (`start "QQ"` or `Start-Process`), wait for its window, then `get_app_state`
  — the CUA surface has no launch primitive.
- After switching apps (or surfaces) you MUST re-observe — element indices
  and screenshot coordinates belong to the observation that produced them.

## Target syntax

```
element target:    { "type": "element", "index": 0 }        // the [0] row of the get_app_state tree
coordinate target: { "type": "coordinate", "x": 120, "y": 45 } // pixels of the LAST screenshot you received
app_ref:           { "pid": 48412 } or { "name": "DUYA" } or { "windowId": 62459564 }
```

- Element indices start at `[0]`, scoped to the app_ref's last observation
- `name` matches by substring (visible windows first, minimized windows as
  fallback); multi-window hits are refused — disambiguate with pid or windowId
- `windowId` is an exact match and works for minimized windows too;
  `cloaked` windows (suspended UWP / another virtual desktop) are refused
- Out-of-bounds coordinates / no frame → `STALE_STATE`; retake the screenshot

## Reading an observation

```
app: pid=48412 "DUYA"
window: "DUYA" window_id=62459564 bounds=[511,73,1493,1217]
elements (2):
 [0] button OK (pressable) actions=[AXPress]
 [1] textfield 搜索 = http://... actions=[AXSetValue]
```

- Row format: `[index] kind title = value (focused) (pressable) (has_menu) actions=[...]`
- Trees above 1500 entries are priority-trimmed and flagged "indices are
  sparse" — hidden indices must not be guessed; re-observe
- Delta mode appends `+ / ~ / - / focus:` change lines at the end; for the
  full tree, observe the same app_ref again
- A password field's value never appears

## Typical flow

Drive a background app:
1. If the app is not running, launch it via Bash first. Then `list_apps` for
   the pid (minimized windows: take the `windowId` from `list_windows`, or
   just `get_app_state` by `name`) → `get_app_state {app_ref, includeScreenshot: true}`
2. Find the target row in the tree → `perform_action {appRef, target:{type:"element",index:n}, action:"AXPress"}`
   or `set_value {target:{type:"element",index:n}, value:"text"}`
3. `get_app_state` again (same app_ref; delta is cheap) to confirm the effect
   before the next step

Verification cue: the receipt's `element` field is the post-action read-back
(name/value/controlType) — compare it against the expected state instead of
asserting success from memory.
