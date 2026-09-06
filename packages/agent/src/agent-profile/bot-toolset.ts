/**
 * Bot toolset declaration (Plan 481 P1.2).
 *
 * The canonical set of tool names every bot profile gets on top of its base
 * tool profile. Bots are config.toml `[agents.<id>]` profiles (plan 424);
 * their base profile may be `coding` / `minimal` / `research`, none of
 * which expose the bot collaboration tools — without this declaration the
 * tools were only reachable through the `full` profile's `'*'` allowlist.
 *
 * Membership rules (Plan 481 §3 tool table, extended by Plan 492 P4.4):
 *   - send_to_agent (T2, plan 477): async DM delivery between bots.
 *   - update_state  (T1, this plan): memory/state writes into the bot's
 *     own shard (479 tier store).
 *   - SendMessage (plan 483 P2): the bot's only voice to the user.
 *   - create_agent / update_agent (plan 492 P4): teammate self-management
 *     (grok sand-agent-management-tools parity; exposed from turn one per
 *     the 490 exposure comparison).
 *   - image_generate (2026-09-05 membership decision): grok exposes
 *     GenerateImage statically on every non-subagent turn; duya's tool is
 *     discoverable-only, so bots need the exact-name promotion to match.
 *   - manage_routine (Plan 476 P2.3b): bot routine self-management (grok
 *     update_state target "routine" parity). Creates/edits cron-backed
 *     routines bound to the calling bot; scheduled fires wake the bot's
 *     resident session through the 476 wake bus.
 *   - post_to_room (T3, plan 478): a member's only voice into a shared room
 *     (grok group SendMessage parity). background_tasks (T6) stays optional
 *     pending the 476 P3.3 evaluation. tool_schema / tool_invoke (T4/T5) are
 *     always-exposed for every profile and are deliberately NOT in this set.
 *     ReactToMessage (plan 490 P1) will register always-exposed instead,
 *     mirroring grok's SAND_FORCED_STATIC placement — also not in this set.
 *   - list_app_connectors / connect_app (plan 503): connector elicitation
 *     (grok AuthenticateMcpServer parity) — bots may discover providers and
 *     start an authorization (connect card), but can never complete it
 *     without the user's consent click. Interactive main-session agents are
 *     deliberately excluded: they keep the settings-page connect flow.
 *
 * Deny always wins: a bot that explicitly denies one of these tools in
 * `[agents.<id>.tools]` keeps the deny — ToolFilter applies after this
 * append.
 */

import type { AgentProfile } from './types.js';

export const BOT_TOOLSET: readonly string[] = [
  'send_to_agent',
  'update_state',
  'SendMessage',
  'create_agent',
  'update_agent',
  'image_generate',
  'manage_routine',
  'post_to_room',
  'list_app_connectors',
  'connect_app',
];

/**
 * Append the bot toolset to a profile's allowlist (idempotent). An existing
 * `'*'` allowlist keeps the wildcard AND gains the explicit bot tool names:
 * plan 496 exposure promotion only surfaces a discoverable tool when its
 * name appears EXACTLY in the allowlist, so a bare `'*'` bot (the default
 * `full` base profile) previously never saw `SendMessage` — the bot's only
 * voice — without a tool_search round-trip the model cannot know to make.
 * An undefined allowlist stays a no-op (no explicit tool decisions to
 * amend). Deny entries are never touched.
 */
export function applyBotToolset<T extends AgentProfile>(profile: T): T {
  const allow = profile.allowedTools;
  if (!allow) {
    return profile;
  }
  const merged = [...allow];
  for (const tool of BOT_TOOLSET) {
    if (!merged.includes(tool)) {
      merged.push(tool);
    }
  }
  return { ...profile, allowedTools: merged };
}
