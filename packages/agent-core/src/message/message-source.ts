export {
  BOT_DIRECT_VISIBLE_SOURCES,
  BOT_INTERNAL_SOURCES,
  DEFAULT_MESSAGE_SOURCE,
  ROOM_HISTORY_SOURCES,
  ROOM_VISIBLE_SOURCES,
  isBotDirectVisible,
} from '@duya/agent-protocol/message-timeline';
export type { MessageSource } from '@duya/agent-protocol/message-timeline';

/**
 * MessageSource — origin classifier for persisted MessageEntry rows.
 *
 * Plan 489 P0.1 (2026-09-03):
 * The bot-direct chat surface (BotDirectChatView) is required to show ONLY
 * messages produced by SendMessage. Bot agent runs naturally emit
 * tool_use / thinking / plain assistant text — those must be hidden from
 * the user, persisted under a different `source` so projection queries
 * can filter them out at the data layer (not just at the UI layer).
 *
 * Values:
 *  - 'user'           → user-typed message (typed in composer, automation)
 *  - 'send_message'   → output of SendMessageTool — the ONLY thing a bot
 *                       says to the user; visible in bot-direct view
 *  - 'tool_use'       → LLM-emitted tool_use block + tool_result block
 *                       (visible only in workspace / audit views)
 *  - 'thinking'       → LLM reasoning / thinking block
 *  - 'scratchpad'     → plain assistant text NOT wrapped in SendMessage;
 *                       this is the bot's "private scratchpad" per the
 *                       SendMessage description (visible in workspace
 *                       views and LLM context, hidden from user)
 *  - 'system'         → system prompt / hook invocation / permission
 *                       notification / TaskTool notification
 *  - 'channel_mirror' → gateway_user:appendMirror writes from external
 *                       channels (Slack/Discord redelivery ledger)
 *  - 'reaction'       → ReactToMessage output (plan 490 P1): an emoji
 *                       tapback row targeting another message via
 *                       metadata.reaction. Mirrors grok's transcript-entry
 *                       reactions; rendered later as a pill on the target
 *                       bubble (UI pending — plan 491 P2 surface).
 *  - 'group'          → Plan 478: a bot's PostToRoom message inside a shared
 *                       room transcript (session `room:<roomId>`); the bot's
 *                       only voice in a group (grok send-message room entry).
 *  - 'group_system'   → Plan 478: room lifecycle notices (turn concluded,
 *                       member pass notes) rendered as system rows in the
 *                       group room view.
 *
 * `source` is inferred at the IPC boundary (`ipcMessageToNewEvent`) when
 * the caller does not supply one explicitly. The inference rules live in
 * `electron/ipc/core-db-adapters.ts::inferMessageSource`.
 */
