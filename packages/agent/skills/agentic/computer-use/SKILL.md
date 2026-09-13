---
name: computer-use
description: Operating manual for the computer_use tool — 9-action reference, coordinate mapping, verify→escalate verdict ladder, platform hotkeys, background rules, safety and failure modes.
paths: []
---

# Computer Use Operating Manual

This skill is auto-loaded when Computer Use mode is enabled. It is the
long-form reference behind the short `computer_use` tool description and
the mode's system prompt. Read Sections 1–3 before touching any tool —
they decide *how you see and where you click*. Sections 4+ cover the
mechanics of each action and what to do when something goes wrong.

## 1. How You Operate (Pure Vision + Click)

There is **no app/window enumeration and no focus-by-name**. The action
set was cut down to 9 actions (`capture / click / type / key / scroll /
drag / set_value / wait / zoom`) and `window_switch`/`list_apps` were
removed. You navigate entirely by looking at screenshots: capture, read,
click, verify. If you cannot see it, you cannot act on it.

Every state-changing step follows the loop:

1. **LOOK** — `capture(somMode=true)` to see the full screen with numbered
   SOM markers.
2. **ZOOM when unsure** — small text, dense toolbars, a specific dialog:
   `zoom(x, y, w, h)` around the region, then read the returned image.
3. **ACT** — one `click`, `type`, `key`, `scroll`, `drag`, or `set_value`.
4. **VERIFY** — `capture(somMode=true)` again and confirm the step landed
   before the next one.

Never act on a screen state you have not just seen this turn. A stale
screenshot is a liability, not a shortcut.

## 2. The Verify → Escalate Ladder

`capture` / `zoom` input is needed before acting; but a status-changing
action (`click`, `type`, `key`, `scroll`, `drag`, `set_value`) returns a
`data.verdict.effect` in its result. Treat it as your primary feedback
signal — do not re-capture and guess by eye alone when the verdict tells
you there was no-op.

The verdict has **three states**, and your next move depends on it:

| verdict.effect   | Meaning                                        | Suggested next move            |
|------------------|------------------------------------------------|--------------------------------|
| `confirmed`      | The action measurably changed the screen.      | Continue the loop; verify target of next action. |
| `unverifiable`   | The backend could not tell whether it landed (e.g. no pointer signal, no screen delta). | **Re-capture and read the screen yourself.** If the intent is satisfied, move on; otherwise re-issue precisely. |
| `suspected_noop` | No on-screen change was detected — the action likely did not land. | **Re-capture FIRST to see the actual state, then decide** whether to re-issue with a corrected target. **Never blindly repeat the same click or key in a row.** |

Key rule: **see `suspected_noop` → re-capture before retrying, and never
mashed-repeat.** Blind repetition is the #1 cause of double-clicks,
accidental confirms (dialogs you did not mean to accept), and toggles
that land twice. If a `suspected_noop` recurs ~3 times on the same
target, escalate: `re-capture`, then `raise` (re-ZOOM around the target
to look closer), and if the window is not top-most, `foreground` it.

Escalation vocabulary (your choices when a target is not reachable):

- **re-capture** — fresh `capture`/`zoom` to get an up-to-date frame;
  always the first move when a result looks wrong.
- **raise** — bring the target window to the front (via the backend's
  foreground control) when it is occluded or not found by the click
  even after a re-capture.
- **foreground** — make the target the active window before acting, when
  the previous action failed because another window stole focus.

## 3. Coordinate Rules (Load-Bearing)

- `x` / `y` are pixels in the **last image you received** — the full-screen
  capture, or the zoom crop.
- After a `zoom`, coordinates are **relative to the cropped image** (its
  top-left is 0,0). The frame resets on your next full `capture`. The
  **backend maps crop coordinates to real screen space** — never add your
  own offsets.
- Copy coordinates from what you actually see. **Never estimate from
  memory** of a previous screenshot; if the screen may have changed,
  re-capture.
- For zoom, `zoom(x, y, w, h)` uses the same last-frame coordinates for
  `x`/`y` and adds `w`/`h` for the region size.

## 4. The 9-Action Reference

Every call requires `action`; the rest are branch-specific.

- **capture** — screenshot. `somMode: true` adds numbered SOM markers;
  `displayId` targets a specific display. Use `somMode=true` for every
  full-screen read.
- **click** — one mouse click. `element` (SOM index) *or* `x`/`y`;
  `button` = `left|right|middle` (default left); `count` =
  `single|double|triple` (double/triple select words/lines);
  `modifiers` = held keys. For text input **click the field first**.
- **type** — type `text` into the focused field; `delayMs` sets
  per-keystroke delay. Only type into a field you have just clicked and
  can see.
- **key** — press `key` (name) with optional `modifiers`. One key event
  per call.
- **scroll** — wheel scroll. `direction` = `up|down|left|right`; `amount` =
  wheel ticks.
- **drag** — mouse drag. `from{X,Y}` (or `fromElement`) to
  `to{X,Y}` (or `toElement`); `steps` = intermediate positions (smooth the
  path); `modifiers` supported. Start/end each in the target field.
- **set_value** — replace the **whole** value of the focused field with
  `value`. Requires the field to be focused first (usually a prior
  `click`); it does not append.
- **wait** — sleep `ms`. Use 1000–3000 ms after launching apps, opening
  menus, or submitting forms before re-capturing.
- **zoom** — crop the region `(x, y, w, h)` for close inspection; returns
  an upscaled view whose coordinates are relative to the crop.

## 5. Platform Hotkeys

`key` takes a key name; combine with `modifiers` (`ctrl|alt|shift|meta`).
Use platform-appropriate modifiers.

- **Enter** — `enter` (confirm / activate).
- **Tab** — `tab` (move focus). **Shift+Tab** moves backwards.
- **Esc** — `escape` (dismiss dialog / cancel / close menu).
- **Paste** — `ctrl+v` on Windows/Linux, `cmd+v` on macOS (`meta+v`).
- **Copy** — `ctrl+c` on Windows/Linux, `cmd+c` on macOS.
- **Save** — `ctrl+s` / `cmd+s`. **Open** — `ctrl+o` / `cmd+o`.
- **New window/tab** — `ctrl+n` / `cmd+n` (varies per app).
- **Close** — `ctrl+w` / `cmd+w` (tab/window; be careful in editor apps).
- **Undo** — `ctrl+z` / `cmd+z`.
- **Select all** — `ctrl+a` / `cmd+a`.
- **Arrow keys** — `up`, `down`, `left`, `right`; combine with `shift` to
  extend a selection.
- **Space** — `space` (toggle scroll / large button activation).

Because there is no focus-by-name, when you need a keyboard shortcut on a
specific window, ensure that window is foreground first (see
Section 2's `foreground`), then send the key.

## 6. Background & Focus Rules (Hard Rules)

Four rules govern whether you may touch a window that is not foreground.

1. **Never grab focus unless necessary.** Prefer acting on the foreground
   window. Do not raise/foreground other windows just to "politely check"
   — only to act.
2. **Capture defaults to background, raise=false.** `capture` reads a
   window without bringing it forward. Use background reads for cheap
   inspection; only `raise`/`foreground` when you must act on that window.
3. **Prefer the same window.** Sequence clicks, keys, and reads within the
   same window before switching. Jumping windows is slow and error-prone.
4. **Cross-window moves may raise when necessary.** When you must act on a
   background window, raise or foreground it for that action, then return
   to the original foreground when done.

If a click on a background window does not land even after a re-capture,
it is usually because the OS delivered the click but the window ignored
it while inactive — raise/foreground it and re-issue, rather than
incrementally re-clicking.

## 7. Safety

- **SOM overlap**: element markers can overlap in dense screens. A click
  on a marker covered by another element may hit the wrong target —
  re-capture at zoom to disambiguate before clicking. Never click an
  element you cannot see clearly.
- **Redacted / password fields**: a focused field reported as redacted
  refuses `type` / `set_value`. Never work around it; never guess the
  contents from visual hints.
- **Refusal codes are policy, not bugs**: `APP_BLOCKED`,
  `REDACTED_FIELD`, `BLOCKED`, and `USER_REJECTED` all mean **stop that
  approach and tell the user** — do not try variations or re-request the
  same destructive/blocked action.
- **Confirmation timeouts**: `click`, `drag`, and `set_value` pop a ~3s
  confirmation; a timeout cancels the action. If you intended the action
  to land, that means it did not — re-capture and decide, do not assume.
- **User may revoke control at any moment** (stop button on the overlay).
  If actions start failing immediately after a revocation, stop and hand
  control back; do not try to fight the lock.

## 8. Failure Modes — Quick Troubleshooting

| Symptom                                  | Likely cause                                        | Fix                                                               |
|------------------------------------------|-----------------------------------------------------|-------------------------------------------------------------------|
| `capture` returns an empty/black frame   | Target display not ready, or app still launching    | `wait` then re-capture; check `displayId`.                        |
| `click` lands but nothing changes        | Wrong coordinates, window inactive, or `suspected_noop` | Read `verdict.effect`; re-capture; `foreground`; re-issue precisely. |
| `type` inputs nothing                    | Field not focused, or field is redacted             | Click the field first (re-capture to confirm focus); check refusal.|
| Menu won't open / collapses immediately  | Menu needs a moment, or an Enter landed twice       | `wait` 1–2s, re-capture; send the trigger once.                   |
| `set_value` replaced nothing             | Field never got focus                               | Click into the field, confirm caret, then `set_value`.            |
| Hotkey has no effect                     | Wrong modifier set, or window not foreground        | Verify platform modifier (Section 5); foreground the window.      |
| Repeated `suspected_noop` on same target | Target occluded, or coordinate refers to stale frame| Escalate: re-capture → raise → foreground (Section 2).            |
| Scroll scrolls the wrong pane            | Mouse was over a different region                   | Re-capture; move pointer over target pane before scrolling.       |

## 9. Closing Rules

- One state-changing action per step; verify after each. Do not batch
  clicks or keys without reading the result.
- When a goal is unreachable after ~3 attempts, stop and report what you
  see rather than guessing or escalating beyond your control scope.
- Report to the user in their language and describe *what the screen now
  shows*, not a count of tool calls.