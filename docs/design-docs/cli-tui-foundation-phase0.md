# CLI TUI foundation — Phase 0

> Date: 2026-10-15. Status: proposal based on current local source inspection.
> Scope: Host-backed `@duya/cli`, especially `packages/cli/src/chat.ts` and
> `packages/cli/src/tui/`. No runtime implementation is included in this document.
> Relationship: foundation proposal for plan 611; Host/runtime contracts remain
> governed by plan 587. This document does not create another execution queue.

## 1. Decision

Build a terminal application shell with explicit boundaries between application
state, interaction, document layout, and terminal output. Use grok-build as the
interaction/scrolling reference, pi as the terminal/component reference, and
minimax-code as the application composition reference.

Recommended direction: a pi-style line renderer behind a Duya-owned interface.
Evaluate reuse of the local pi engine in one bounded integration spike before
choosing a dependency or a maintained source import. Keep the current backend
during that evaluation. Do not expand both blessed and a new renderer as two
permanent frameworks.

Product direction: inline conversation with native terminal scrollback; explicit
fullscreen history/picker views when needed. Preserve the current default until
the new path passes terminal acceptance. The current inline mode is opt-in via
`DUYA_TUI_INLINE`; this is a proposed direction, not a claim about today's default.

The immediate task is to make ownership and lifecycle reliable. Markdown, tool
cards, syntax highlighting, images, and feature parity can follow independently.

## 2. Verified current structure

| Area | Current evidence | Foundation implication |
| --- | --- | --- |
| Product entry | `chat.ts:450` creates `TUIApp`, manages sessions, starts/watches/cancels Host runs | Keep execution in Host; CLI remains a client |
| Host projection | `chat.ts:400` converts protocol envelopes to `LegacyFrame` and drops unhandled variants | Retain envelope identity/order at the adapter boundary; define supported event coverage |
| Shell | `TUIApp.ts` owns terminal creation, widgets, input routing, activity, usage, scrolling, overlays and painting | Extract real owners, rather than moving methods into helper files with shared mutable state |
| Backend split | Constructor creates blessed Program; fullscreen creates Screen; inline creates `InlineSurface` | One terminal/session owner must coordinate every write and mode change |
| Modal takeover | `paintInline` creates a blessed alternate screen for overlays, then destroys it on close | Mode transitions need explicit suspend/restore semantics and lifecycle tests |
| Transcript cache | `TranscriptRenderer.blocks()` hashes/scans all blocks; `lines()` flattens all rows | Cached markdown is useful but does not establish viewport-only layout complexity |
| Inline commit | `InlineSurface.render()` commits rows leaving the live region and tracks a row offset | A geometric overflow boundary is not proof that those rows can never change |
| Input | `routeContended()` routes prompt → permission → window → completion → editor/history | Useful existing policy; generalize into a single focus/action router |
| Scheduling | DeltaBuffer, Pacer, RenderScheduler already separate token arrival from repaint | Preserve and measure them; avoid layering another independent pacing loop |
| Unicode | Width uses blessed's table; editor currently documents code-point semantics | Choose one grapheme/cell-width policy across editor, wrapping, clipping and cursor placement |

`stream-commit.ts` still describes an alt-screen-only world while an inline
commit surface now exists. Reconcile that contract during extraction: text safe
to interpret as Markdown and rows safe to write irreversibly are different facts.

The current Host-backed `chatTui()` rejects busy submissions. Plan 611's queue
implementation describes the legacy agent adapter; it does not establish queue
support in this production path. Queue semantics must be implemented at the CLI
controller boundary if retained as a product requirement.

The working tree already contains CLI/Host changes and untracked TUI files.
Observations here concern that tree, not a pristine commit. No existing edits
were reverted or incorporated into an implementation by this investigation.

## 3. What to borrow from the references

All paths below refer to the user's local clones, inspected on the date above.
They are source references, not claims about the latest upstream versions.

| Reference | Source | Borrow |
| --- | --- | --- |
| grok-build | `crates/codegen/xai-grok-pager/src/app/event_loop.rs` | Terminal/remote/task/tick inputs enter one application dispatch boundary |
| grok-build | `crates/codegen/xai-grok-pager/src/actions/mod.rs` | Keys, hints and command palette share an action registry with explicit context bubbling |
| grok-build | `crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs` | Cached heights/prefix positions, paint-window lookup, structural scroll anchors |
| pi | `packages/tui/src/terminal.ts`, `stdin-buffer.ts` | Injectable terminal, lifecycle, complete input-sequence buffering and capability negotiation |
| pi | `packages/tui/src/tui.ts` | Small component contract, invalidation, focus, cursor coordinates and overlays |
| minimax-code | `packages/tui/src/tui/state/store.ts` | State transition produces effects; effects return actions rather than mutating widgets |
| minimax-code | `packages/tui/src/tui/app-composition.ts` | Composition creates services and connects dependencies |
| minimax-code | `packages/tui/src/tui/renderer/interactive-renderer.ts` | Explicit regular/fullscreen switching with captured renderer state |

Avoid wholesale framework copying. Grok's Rust runtime and minimax's large
product-flow tree are unnecessary for this scope. The inline crate's README
describes terminal reset/replay on resize; do not adopt that policy without
testing its effect on existing shell scrollback.

## 4. Target ownership and data flow

```text
Terminal input / resize / lifecycle      Host stream / API responses
                  |                                  |
          TerminalSession                       HostChatAdapter
                  |                                  |
           normalized input                  identified domain events
                  +------------------+---------------+
                                     v
                          ChatController.dispatch
                                     |
                       state transition + effects
                         /                     \
              UI/document state              EffectRunner
                         |                 Host calls / async lookup
                   frame scheduler              |
                         |                  result actions
             layout + visible document range
                         |
                 RenderFrame + cursor
                         |
                  SurfaceBackend
                         |
              TerminalSession output queue
```

- **TerminalSession** owns stdin/raw mode, output serialization, resize,
  capability negotiation, mouse/paste/keyboard modes, suspend/resume and cleanup.
  Construction does not acquire the terminal; `start()` acquires it, `dispose()`
  releases it even after partial startup. No independent stdout writers.
- **ChatController** owns active session/run identity, admission, cancellation,
  local pending submissions, session transitions and async request generations.
  It calls Host APIs through an adapter and never executes tools or model turns.
- **UI state** owns focus, overlay stack, draft, selection, scroll anchor,
  follow mode, activity and local notifications. Domain events enter in order.
  Keep transport connection state separate from run execution state.
- **TranscriptDocument** owns identified blocks and revisions, plus live/final
  state. UI decorations and paced visibility do not alter canonical content.
- **LayoutIndex** owns width-dependent wrapped heights, source-to-row mappings,
  anchors and cache invalidation. Update changed blocks; query visible ranges
  without flattening the entire document on every input/spinner frame.
- **SurfaceBackend** consumes prepared frames. It owns inline commit/live redraw
  or fullscreen paint semantics, but not application decisions or Host state.
- **Widgets** own local presentation: composer, selector, status, history view.
  They emit actions and return render output; they never write terminal bytes.

Start with a small reducer for shell/session transitions and retain existing
editor/transcript classes as exclusive owners of their internals. Do not copy a
large transcript or every token into a second global store. Derive busy/status
from controller state rather than maintaining competing booleans in callbacks.

## 5. Foundation contracts

### Terminal and lifecycle

One serialized output path covers commit bytes, frame diffs, cursor placement,
mode transitions and restoration. Backpressure must preserve commit/control
operations; obsolete pending paint snapshots may be coalesced. Escape-safe
chunking alone is not a complete backpressure policy.

Provide `start`, `suspend`, `resume`, `dispose` and injected size/input/output.
Unsubscribe listeners and cancel timers at teardown. Modal close must not destroy
the shared input owner. Close outstanding picker promises with cancellation.
Flush canonical final content before leaving; do not leave a paced tail invisible.

Terminal capabilities carry detected/negotiated/fallback status. Unsupported
queries have timeouts and responses never enter the editor. Non-TTY output keeps
the existing plain/readline path. Externally supplied content cannot inject cursor
control commands; trusted renderer controls use a separate output path.

### Layout and history

Use one geometry calculation per frame: terminal bounds → chrome budget → live
conversation bounds → overlay bounds → cursor. Clamp tiny terminals explicitly;
growing composer or completion lists must not accidentally commit mutable rows.

Distinguish three different states:

1. Canonical source accepted from Host.
2. Currently revealed/rendered live content, including mutable streaming blocks.
3. Stable prefix already committed into native scrollback.

Only a renderer-declared stable prefix may be committed. Completed blocks are the
safe initial rule. A streaming block taller than the viewport remains accessible
through an application history view; later stable-prefix streaming can improve
native scrollback without weakening this rule.

Track commit identity with document/session generation and stable block/source
position, not only an integer count of visual rows. Resize can change wrapping;
session replacement can have the same number of rows as the old document.

Use `{blockId, sourceOffset, affinity}` for a scroll bookmark, resolved through
layout after resize/folding. App history navigation and native scrollback are
different mechanisms: committed native rows cannot be edited by the app. Open a
fullscreen reader for arbitrary history/search/folding; restore the live view
and draft when it closes. On session switch, mark the native history boundary
and begin a new document generation; do not erase prior shell history implicitly.

### Input and interaction

Normalize complete key, paste, mouse and terminal-response events before routing.
Keep byte decoding separate from action selection. Use one registry for dispatch,
help and hints; one key is consumed at most once.

Top modal captures ordinary input; then completion; then focused editor/history;
then eligible global actions. Approval requests join a controlled interaction
queue and do not steal input from an unresolved prompt. Define Ctrl+C separately
for modal cancellation, active-run interruption and idle exit. Restore previous
focus and draft after every interaction.

Retain current undo, kill ring, paste placeholders and completion implementations
behind adapters. Test `/ses` → `/` → empty and stale async completion cancellation.
Grapheme editing, cell width, ANSI clipping and hardware cursor positioning must
agree; Windows Chinese IME placement belongs in real-terminal acceptance.

### Host and asynchronous effects

Retain `sessionId/runId/seq` through projection. Separate replay deduplication from
UI pacing, and ignore late results belonging to an obsolete session generation.
Use Host's established event/cursor and settlement contracts rather than inventing
a second execution protocol in TUI.

Submission has one explicit admission result before an accepted user row is
recorded. Running submissions may become local pending drafts with visible
queued state; they must not look like accepted Host messages. Session switching
is blocked while a run/pending queue exists until an explicit policy is supported.
Explicit interruption pauses automatic queue drain; failed runs do likewise.
Normal settled completion may drain the next item. No concurrent run is started
because multiple UI callbacks observed a stale busy flag.

Represent permission response support as an adapter capability. An overlay alone
does not establish Host approval support; unsupported actions cannot look active.

## 6. Proposed module map

Keep this under `packages/cli/src/tui` initially. Extract a workspace package only
after a real second consumer needs the same engine.

```text
tui/
  app/           composition, controller, shell state, actions, effects
  adapters/      Host event projection and session/run API boundary
  terminal/      session lifecycle, capabilities, input decoding, writer
  interaction/   focus/overlay stack, keymap, action routing
  document/      transcript revisions, layout index, stable commit boundary
  surfaces/      inline/fullscreen backend adapters
  widgets/       existing editor, completion, picker, chrome adapters
  testing/       fake terminal, virtual terminal, replay/scenario harness
  TUIApp.ts      compatibility facade during migration
```

These are ownership boundaries, not a requirement to create every directory in
one PR. Existing modules move only with their production callers and tests.

## 7. Delivery sequence and exit criteria

| Slice | Deliverable | Exit criterion |
| --- | --- | --- |
| F0 | Reproducible fixture runner and current failure signatures | Same event/input fixture runs without model/network; submission failures and lifecycle warnings classified |
| F1 | TerminalSession + current backend adapter | Repeated start/modal/close/dispose restores terminal and listener counts; all output uses one writer |
| F2 | Controller + focus/action routing | Real Host-backed entry uses it; single submission echo, deterministic busy/cancel policy, stale session effects rejected |
| F3 | Document/layout/stable commit contracts | Resize/session swap cannot duplicate or lose committed content; off-tail anchor survives streaming |
| F4 | pi backend integration spike | Composer, streaming document, picker, inline/fullscreen return and Chinese input pass the same fixtures |
| F5 | Select backend and migrate production entry | Chosen backend passes real-terminal acceptance; retire superseded output/input path after consumer inventory |

F4 is the decision gate: prefer pi reuse if its interface, Windows behavior,
scrollback policy and packaging fit. If it fails a concrete requirement, keep the
existing inline renderer behind the same contracts and record the failing fixture.
Do not start an open-ended pi fork. Pin any adopted source/dependency and review
its license, notices, Node requirements and native packaging before integration.

The legacy agent TUI consumer still imports `TUIApp`; preserve the facade until
that caller is migrated or removed under plan 587. Do not expand its functionality
as a substitute for wiring the Host-backed CLI entry.

## 8. Verification

Use three layers: pure state/layout/input tests; virtual-terminal assertions over
actual output bytes; real PTY/Windows Terminal acceptance. Browser screenshots do
not establish native terminal behavior.

Required scenarios: fast token stream while typing; two large pastes; CJK/emoji
editing; ESC split across chunks; picker open/close while streaming; narrow and
short terminal; repeated width/height resize; 10,000-block history; cancelled and
failed runs with queued drafts; session replacement; exit during pending prompt;
writer backpressure; teardown and restart without listener growth.

Performance acceptance is structural first: unchanged history is not rehashed or
flattened per keystroke/tick; output is bounded by changed viewport/commit work;
input is not queued behind a full-history operation. Record p50/p95 input latency,
layout time, changed rows, bytes and queue depth on this Windows machine before
setting numerical budgets. A cache hit counter alone is insufficient evidence.

Current measurement, 2026-10-15, dirty working tree:

- Command: `node node_modules/vitest/vitest.mjs run packages/cli/src/tui --reporter=dot`.
- Sandbox attempt: collection blocked by `EPERM` resolving Vitest `dist/spy.js`;
  no tests executed. Unsandboxed retry actually ran the suite.
- Result: 31 files, 30 passed / 1 failed; 405 tests, 403 passed / 2 failed.
- Both failures: `__tests__/tui-single-echo.test.ts`, submitted-prompt cases:
  expected `['hey']`, received `[]`; expected echo count `1`, received `0`.
- Several workers reported more than 10 resize listeners. This is a lifecycle
  investigation target, not proof here of the production leak's cause.
- No reference app, real PTY, Chinese IME, packaged build or production Host turn
  was run during this investigation. No implementation or performance result is
  claimed. Full repository gates were not run for this documentation-only change.

Next concrete action: F0's deterministic submission/lifecycle fixture, followed
by F1's TerminalSession extraction. Feature renderers remain outside these slices.
