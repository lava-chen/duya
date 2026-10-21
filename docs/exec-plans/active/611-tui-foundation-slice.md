# 611 — TUI foundation implementation slice

Date: 2026-10-15. Parent: `611-tui-ux-overhaul.md`. Status: implemented, review pending.

## Scope

User direction: Claude Code-like interaction, mcode-like responsiveness. Focus
this slice on event/message flow, composer framework and visible shell layout.
Keep Host execution ownership and preserve unrelated primary-checkout work.

## Implementation plan

1. Compare local Codex/Claude reconstructions; identify evidence and stubs.
2. Give Host envelopes an explicit identity/sequence projection boundary.
3. Introduce a serial local submission controller with pending state and
   interruption policy; integrate the real Host-backed `chatTui` entry.
4. Isolate terminal cleanup/mode lifecycle, preserving keyboard input after
   repeated inline modal open/close.
5. Extract composer layout: cursor-following multiline viewport, bounded geometry,
   quiet chrome and Claude-like horizontal separators. Keep live typing editable.
6. Verify pure contracts, actual TUI integration, PTY and Playwright-driven
   terminal preview. Record test scope and limits, then update architecture.

No backend replacement is required for this slice. Existing editor, completion,
delta buffers and renderer remain behind the extracted contracts. Stable-prefix
scrollback and a pi backend remain follow-up work with explicit acceptance.

## Acceptance

- Actual production `chatTui` uses the new projection/admission controller.
- Replay cannot double-apply a frame; old-run events cannot alter the active run.
- Busy submissions remain visibly pending, never spawn concurrent runs; explicit
  interruption/failed runs pause automatic drain; exit discards local pending work.
- Input below the eighth wrapped row remains visible and cursor-aligned.
- Modal close and final stop restore resources without losing input or leaking
  resize listeners; outstanding interactive prompts settle on stop.
- UI is checked at normal, narrow and short dimensions using emitted terminal
  output, with real PTY input plus a Playwright terminal preview.
- No claim that browser preview establishes physical Windows IME behavior.

## Evidence

Base: `170aaa47`, isolated branch `codex/cli-tui-foundation`. Earlier tests from
the shared checkout are not the baseline of this isolated worktree.

- Before edits: TUI suite 31 files / 405 tests passed; resize listener warnings.
- After edits: TUI + actual `chatTui` wiring suite 38 files / 443 tests passed;
  no resize listener warnings in that run. Includes closed-modal resize,
  two/three-row input, late startup cancellation and FIFO admission.
- `npm run typecheck:all`: exit 0. Electron gate retains 231 known errors across
  111 keys; the gate reports no new type errors. Final CLI check also passed.
- `npm run architecture:check`: exit 0, 2645 tolerated findings, no new violations.
- `npm run electron:build`: exit 0. Existing import.meta and chunk-size warnings
  remain; this is build evidence, not packaged-app or model-turn evidence.
- Playwright CLI drove an actual node-pty fixture through xterm: normal 100x28,
  narrow 42x12, selector open/close, typing after modal return and terminal resize.
  Screenshot files are local under `output/playwright/tui-foundation/`.
- Long-history regression seeds 1200 notices and verifies that typing and
  spinner frames reuse assembled lines. This establishes absence of repeated
  history traversal in those frames, not an mcode performance equivalence.
- New preview entry: `node scripts/preview-cli-tui.mjs`. It makes no model calls
  and uses a loopback-only HTTP server to expose the actual PTY for inspection.

## Reference findings and scope boundary

- Local Claude reconstruction: `src/utils/handlePromptSubmit.ts`,
  `src/hooks/useQueueProcessor.ts`, `src/hooks/useCancelRequest.ts` separate
  queued input, query lifecycle and focused interactions. Its README identifies
  repaired leaked source; several integrations are stubs. No claim of official
  upstream provenance or working feature parity is made here.
- Local Codex: `codex-rs/tui/src/chatwidget/streaming.rs`, `input_flow.rs`,
  `input_queue.rs`, and `tui/history_tail.rs` separate live output, paced history,
  authoritative completion and pending submissions.
- Retained the prior grok/pi/mcode foundation direction, but did not replace
  the renderer. The production consumer now uses the new envelope and admission
  owners; it still projects to the existing narrow `LegacyFrame` vocabulary.

Follow-ups remain: stable source-position commits for native scrollback, a
width-aware transcript layout index (narrow inline history currently clips long
rows), message/item identity beyond run sequence, explicit background-task
projection, and a bounded pi-backend experiment. Physical Windows IME and a real
provider turn have not been tested in this slice.
