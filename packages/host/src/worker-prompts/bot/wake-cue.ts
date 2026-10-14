/**
 * wake/cue.ts — the hidden wake cue opening every routine fire prompt.
 *
 * Single source of truth shared by:
 *   - electron/automation/routine-wake.ts (main builds the fire prompt);
 *   - the bot prompt section (packages/agent/src/prompts/bot/automations.ts)
 *     that teaches the model what the cue means;
 *   - wake source taxonomy (an `automation.fire` wake always carries a
 *     prompt starting with this cue).
 *
 * Keep it a stable, greppable literal — tests and prompt sections match on
 * the exact string.
 */

export const ROUTINE_WAKE_CUE = '[routine]'
