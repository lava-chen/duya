/**
 * Bot toolset declaration (Plan 481 P1.2).
 *
 * The canonical set of tool names every bot profile gets on top of its base
 * tool profile. Bots are config.toml `[agents.<id>]` profiles (plan 424);
 * their base profile may be `coding` / `minimal` / `research`, none of
 * which expose the bot collaboration tools — without this declaration the
 * tools were only reachable through the `full` profile's `'*'` allowlist.
 *
 * Membership rules (Plan 481 §3 tool table):
 *   - send_to_agent (T2, plan 477): async DM delivery between bots.
 *   - update_state  (T1, this plan): memory/state writes into the bot's
 *     own shard (479 tier store).
 *   - post_to_room (T3) joins when plan 478 lands; background_tasks (T6)
 *     stays optional pending the 476 P3.3 evaluation. tool_schema /
 *     tool_invoke (T4/T5) are always-exposed for every profile and are
 *     deliberately NOT in this set.
 *
 * Deny always wins: a bot that explicitly denies one of these tools in
 * `[agents.<id>.tools]` keeps the deny — ToolFilter applies after this
 * append.
 */

import type { AgentProfile } from './types.js';

export const BOT_TOOLSET: readonly string[] = ['send_to_agent', 'update_state', 'SendMessage'];

/**
 * Append the bot toolset to a profile's allowlist (idempotent). An existing
 * `'*'` allowlist is returned unchanged — it already covers everything.
 * Deny entries are never touched.
 */
export function applyBotToolset<T extends AgentProfile>(profile: T): T {
  const allow = profile.allowedTools;
  if (!allow || allow.includes('*')) {
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
