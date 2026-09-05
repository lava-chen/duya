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
 *
 * `source` is inferred at the IPC boundary (`ipcMessageToNewEvent`) when
 * the caller does not supply one explicitly. The inference rules live in
 * `electron/ipc/core-db-adapters.ts::inferMessageSource`.
 */
export type MessageSource =
  | 'user'
  | 'send_message'
  | 'tool_use'
  | 'thinking'
  | 'scratchpad'
  | 'system'
  | 'channel_mirror';

/**
 * Sources that are visible to the end user in a 1:1 bot chat view.
 * Any other source is bot workspace only.
 */
export const BOT_DIRECT_VISIBLE_SOURCES: readonly MessageSource[] = [
  'send_message',
  'user',
] as const;

/**
 * Sources that belong to bot internal execution and must NEVER be shown
 * in the bot-direct chat view. (They live in the bot's own workspace
 * transcript and are surfaced through the bot's profile "Activity" tab.)
 */
export const BOT_INTERNAL_SOURCES: readonly MessageSource[] = [
  'tool_use',
  'thinking',
  'scratchpad',
  'system',
] as const;

/**
 * Default source used when no other inference rule matches. Existing
 * pre-P0.1 data is backfilled with this value, which keeps it bot-direct
 * hidden (matches old "scratchpad" behaviour for bot-side text).
 */
export const DEFAULT_MESSAGE_SOURCE: MessageSource = 'scratchpad';

/**
 * Filter helper for the bot-direct projection. Equivalent to
 * `BOT_DIRECT_VISIBLE_SOURCES.includes(source)` but future-proof.
 */
export function isBotDirectVisible(source: MessageSource | undefined): boolean {
  if (!source) return false;
  return BOT_DIRECT_VISIBLE_SOURCES.includes(source);
}
