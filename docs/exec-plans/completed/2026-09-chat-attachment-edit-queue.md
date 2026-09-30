# Chat attachments, editing, and in-run input

Status: Implemented; automated verification passed, live provider smoke pending. Scope: the three user-reported chat defects.

## Evidence and decisions

- Worker image cache uses filenames; same-name clipboard images overwrite each other.
- Transcript edit immediately rewinds and sends text without attachments.
- Checkpoint mailbox adaptation ignores attachments; empty-text guards discard attachment-only input.
- Pending messages render both in the transcript and above the composer.
- Restore editable text and attachments into the main composer. Rewind only on submission; cancelling preserves history and the prior draft.
- Pending edits remain pending until submission. Atomic cancellation must succeed before replacement; observed input cannot be resent accidentally.
- Keep the configured queued/followup policy. Show routing status and attachment previews once above the composer.

## Steps

- [x] Share image loading and preserve attachment identity.
- [x] Include attachment text and image blocks in checkpoint guidance, including image-only input.
- [x] Restore transcript and pending edits to the full composer with cancellation and failure handling.
- [x] Clarify pending status and remove duplicate transcript projection.
- [x] Run focused regressions, typecheck:all, Electron build, and browser component checks.

## Verification

- Final targeted suites: 27 attachment/composer/store tests and 9 checkpoint/queue/attachment-bar checks passed. Added regressions cover distinct same-name image bytes, actual checkpoint image-only injection, full composer restoration/cancellation/retry, and the late mailbox-save promotion race.
- `npm run typecheck:all` passed with `NODE_OPTIONS=--max-old-space-size=6144`.
- `npm run electron:build` passed with `NODE_OPTIONS=--max-old-space-size=12288`. The first attempt exited during Vite chunk generation without a diagnostic; increasing the heap and rerunning the full command succeeded.
- Real-component Playwright browser checks passed for edit/cancel, pending attachment restoration, attachment removal, model selection, failed-submit retry, previews, observed-row action locking, and light/dark themes at 1100px/420px. Temporary harness files were removed.
- A broader 123-test run had 120 passes and three existing failures. Repeating the failing cases with the original `DuyaAgent.ts` and `stream-session-manager.ts` reproduced all three: empty background follow-up request count, deferred tool context projection, and proactive compaction. They are outside this change.
- [ ] Live provider smoke in the Electron app: send two visibly different same-name images, then append an image while tools are running. Browser fixtures and provider-payload tests do not establish real model interpretation.
