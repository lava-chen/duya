# Plan 516 — Sidebar awaiting-input pill

> Show a "waiting for you" indicator next to sidebar buttons whose bound
> session is paused on a permission ask, a tool approval, or a connector
> auth request — so the user can spot a stuck session without opening its
> chat.

## Why

Plan 494 (`494-bot-direct-ask-cards.md`) made sure bot-direct renders its
own `BotAskCard` / `BotPermissionCard` so the stream never deadlocks on a
permission request. But the **sidebar** row for that bot / thread still
looks identical to an idle one. Switch to another bot or workspace and you
have no idea that one of them is waiting for your answer.

Three independent streams surface a "your turn" moment:

1. `permission_request` SSE event with `toolName === 'AskUserQuestion'` —
   `BotAskCard` / `ChatView` `AskUserQuestion` sheet.
2. `permission_request` SSE event for any other tool — `BotPermissionCard`
   / `ChatView` `PermissionPrompt` sheet.
3. `chat:connector_auth_required` IPC event — `ConnectorAuthRequiredCard`.

Each of them already publishes into the shared `StreamSessionManager`
snapshot (`pendingPermissionRequest`, `pendingConnectorAuthRequest`) and
already has a subscription API
(`subscribeToPermissions(sessionId, cb)`,
`subscribeToConnectorAuthRequired(sessionId, cb)`,
`getSnapshot(sessionId).pendingPermissionRequest`).

What's missing is a **sidebar consumer**.

## Scope

| In scope                                                          | Out of scope                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Sidebar bot contact row pill (`BotContactListItem`)               | Inside-chat card rendering (already covered by plan 494)    |
| Sidebar thread row pill (`ThreadListItem`)                        | Auto-approving / new permission profile logic               |
| Trailing text pill in the existing trailing slot                  | Notification tray integration (already covered by `usePermissions`) |
| `AskUserQuestion` + tool approval + connector auth                | Customisable per-bot mute or snooze rules                   |

## Approach

Reuse the existing `subscribeToPermissions` /
`subscribeToConnectorAuthRequired` /
`getSnapshot(...).pendingPermissionRequest` /
`getSnapshot(...).pendingConnectorAuthRequest` APIs from
`src/lib/stream-session-manager.ts`. No new store, no new IPC.

Each row component mounts the two subscriptions against its bound
`sessionId`, holds the latest event in local `useState`, and clears it
when the stream publishes `null` (which already happens on
`permission:response` / `permission:auto` / stream end — see
`stream-session-manager.ts:2569, 2591, 2610`).

**Display priority** inside the trailing slot:

1. `awaiting-input` pill — always wins when a permission / auth request
   is pending on this session.
2. `queued` pill — existing behaviour.
3. relative time — existing behaviour.

The pill text and CSS modifier come from the request kind:

| Source           | Pill text         | CSS modifier          | i18n key                              |
| ---------------- | ----------------- | --------------------- | ------------------------------------- |
| `AskUserQuestion`| `bot.contactStatus.awaitingAnswer`     | `.bot-contact-status-pill.awaiting-input` | `bot.contactStatus.awaitingAnswer`   |
| Other `toolName` | `bot.contactStatus.awaitingPermission` | same | `bot.contactStatus.awaitingPermission`|
| `ConnectorAuth`  | `bot.contactStatus.awaitingAuth`       | same | `bot.contactStatus.awaitingAuth`      |

The same CSS class is shared between bot and thread rows — already
established pattern for `.bot-contact-status-pill.queued`. Rename later
if we want to drop the "bot-contact" prefix; for now keep the existing
selector stable for any other consumer.

## Files to change

| File | Change |
| --- | --- |
| `src/components/layout/sidebar/BotContactListItem.tsx` | Subscribe to the two events against `contact.boundThreadId`; render pill in trailing slot (priority > queued > time). |
| `src/components/layout/sidebar/ThreadListItem.tsx` | Same, against `thread.id`. |
| `src/styles/sidebar.css` | Add `.bot-contact-status-pill.awaiting-input` (amber/warning hue) + shared `.thread-item-trailing` baseline so thread rows render pill without a second style block. |
| `src/i18n/locales/en.json` + `src/i18n/locales/zh.json` | Add `bot.contactStatus.awaitingAnswer / awaitingPermission / awaitingAuth` (and `thread.contactStatus.*` if needed). |
| `src/components/layout/sidebar/BotContactListItem.test.tsx` *(new if absent)* | Mount with mocked `subscribeToPermissions` firing an `AskUserQuestion` event → pill renders. Mock firing `null` → pill clears. |
| `src/components/layout/sidebar/ThreadListItem.test.tsx` | Same scenario against a regular thread. |

### Do **not** change

- `packages/agent` — agent package stays untouched, plan 494 boundary.
- `BotDirectChatView` / `ChatView` card rendering — already correct.
- `usePermissions` hook — sidebar rows don't need respond / systemNotify.
- `bot-activity-store` — keeps its lastSeen / errored responsibilities.

## Verification

1. `npm run typecheck:all`
2. `npx vitest run src/components/layout/sidebar/ src/hooks/__tests__/usePermissions.test.tsx`
3. Manual Electron smoke:
   - Launch a bot, send a prompt that triggers `AskUserQuestion`.
   - Switch to a different bot in the sidebar → see "待回答" pill on the
     first bot's row.
   - Open the first bot's chat, answer → pill disappears.
   - Repeat with a tool approval (`Bash` in `default` profile) and a
     connector auth request — pill should appear with matching text.
   - Open a regular (non-bot) thread, fire a `PermissionPrompt` from it
     in a way the dev tools can simulate → pill appears on the thread
     row.

## Status

- [x] Plan written
- [x] BotContactListItem wiring (`subscribeToPermissions` + `subscribeToConnectorAuthRequired` → awaiting-input pill wins over queued > time)
- [x] ThreadListItem wiring (same subscriptions, same priority order vs running > pinned > time)
- [x] CSS `.awaiting-input` variant (amber, light + dark mode)
- [x] i18n keys (en + zh: awaitingAnswer / awaitingPermission / awaitingAuth)
- [x] Unit tests (ThreadListItem: 10/10 ✓, BotContactListItem: 6/6 ✓)
- [x] `typecheck:all` passes
- [x] Commit (`7ac28b98`)
- [ ] Manual Electron smoke (deferred — same env constraint as plan 494 T7; pending Electron idle)
- [ ] Push to origin (waiting on user; multi-file feat, may want a PR instead)