# Plan 472 — Unified Attachment Card Visual

**Status**: In progress
**Created**: 2026-08-31
**Priority**: P2
**Owner**: — (UI fix)

## Problem

`AttachmentBar` (Plan 220) rendered attachments through two independent
tracks:

- `fileKindAttachments` → `FileAttachmentCard` (104×104 rounded-2xl square)
- `chipAttachments` → `AttachmentChipCard` (160×min-80 rounded-3xl long chip)

Each track had its own flex-wrap container and its own CSS class family.
When a user pastes both an image and some text, the two cards render on
**two different rows with two different shapes**, which reads as broken UI.
Both call sites (input mode in `MessageInput.tsx`, history mode in
`MessageItem.tsx`) exhibited the split.

## Decision

Merge both tracks into a **single `flex flex-wrap` row**, and bring every
reference card (pasted-text / terminal-ref / browser-ref / file-tree-ref)
to the same **104×104 rounded-2xl square** shape used by images:

- images/files keep the existing `FileAttachmentCard` square visual
- browser screenshots keep the existing square screenshot card
  (`browser-screenshot-attachment-card`)
- everything else renders as a new `ReferenceSquareCard` with a 5-line
  text preview + a bottom kind pill (PASTED / TERMINAL / BROWSER / FILE TREE)
- cards appear in input-array order on the shared row

CSS aliases: `.pasted-content-attachment` and `.message-pasted-content-item`
now share the `.reference-attachment-card` rules so the legacy fallback
render path in `MessageItem.tsx` (decoded history w/o the unified bar)
inherits the same square visual.

## Scope

- `src/components/chat/AttachmentBar.tsx` — merged single row + `ReferenceSquareCard`
- `src/components/chat/FileAttachmentCard.tsx` — added `data-attachment-id` for test parity
- `src/styles/globals.css` — `.reference-attachment-card` rules; removed the
  old `.pasted-content-list` / `.message-pasted-content-list` / long-chip rules
- `src/components/chat/__tests__/AttachmentBar.test.tsx` — 8 tests, all green

## Tests

- `AttachmentBar.test.tsx` — 8/8 pass (all 5 kinds carry `data-attachment-id`;
  image + pasted cards share one flex-wrap parent; input-array order preserved;
  browser screenshot still renders as a single square card)
- `npm run typecheck:all` — clean
- `vite build` — CSS compiles cleanly (globals.css)

## Pre-existing failures (unrelated)

`MessageInput.test.tsx` / `MessageInputPaste.test.tsx` fail on
`No "EyeIcon" export is defined on the "@/components/icons" mock` — the
working tree carries an **uncommitted** `useSlashCommands.ts` change
(plan 454 Computer-Use popover wiring) that references `EyeIcon` without
the test mocks being updated. Not caused by this plan.

## Follow-ups

- [ ] Manual Electron smoke: paste image + text together → one row of
      same-size squares in input; same in message history
- [ ] Move plan to `completed/` after visual sign-off
