/**
 * The permission mode the composer shows, and the key that cycles it.
 *
 * ## One vocabulary, three surfaces
 *
 * The mode is a property of the SESSION, not of the terminal: the Host stores
 * it as `permission_profile` (`default` / `auto` / `full_access`) and both
 * `/permission` and the Desktop's composer read it from there. This module
 * owns the mapping between that stored profile and the three words a person
 * reads — `ask`, `auto`, `bypass` — so the badge in the footer, the cycle the
 * Shift+Tab key performs and the `/permission` command cannot drift apart.
 *
 * ## Why the words are not the profile
 *
 * `full_access` is what the row stores; `bypass` is what the user reads. The
 * stored name is a protocol value and the read one is a warning, and mixing
 * them is how a permission mode ends up displayed as `full_access` in one
 * surface and `bypass` in another.
 *
 * ## The cycle
 *
 * `ask → auto → bypass → ask`. The order is the escalation order: each step
 * grants more, and the step after `bypass` gives it all back. `bypass` is
 * reachable only through a second press (see `TUIApp`), because a single
 * stray Shift+Tab must never hand the agent the whole machine.
 */

import type { SessionPermissionProfile } from '@duya/agent-protocol';
import type { ThemeToken } from './theme.js';

/** The three modes a person reads. */
export type TuiPermissionMode = 'ask' | 'auto' | 'bypass';

/**
 * The cycle order, from the most restrictive to the least.
 *
 * The order IS the escalation ladder, so it is written once and used by both
 * the cycling key and anything that needs to describe what comes next.
 */
export const PERMISSION_MODES: readonly TuiPermissionMode[] = ['ask', 'auto', 'bypass'];

/**
 * The stored profile → the word the user reads.
 *
 * Anything that is not `auto` or `full_access` reads as `ask`: the profile
 * comes off a database row, and a value a newer build wrote must not leave the
 * composer without a mode.
 */
export function permissionModeFromProfile(
  profile: SessionPermissionProfile | null | undefined,
): TuiPermissionMode {
  if (profile === 'full_access') return 'bypass';
  if (profile === 'auto') return 'auto';
  return 'ask';
}

/** The word the user reads → the profile the session stores. */
export function profileForPermissionMode(mode: TuiPermissionMode): SessionPermissionProfile {
  if (mode === 'bypass') return 'full_access';
  if (mode === 'auto') return 'auto';
  return 'default';
}

/**
 * The mode that follows `mode` in the cycle.
 *
 * `bypass` wraps around to `ask`, so the cycle never dead-ends and the way
 * back to the restrictive mode is the same key.
 */
export function nextPermissionMode(mode: TuiPermissionMode): TuiPermissionMode {
  const index = PERMISSION_MODES.indexOf(mode);
  if (index < 0) return 'ask';
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length] ?? 'ask';
}

/**
 * The colour each mode carries.
 *
 * `ask` is the quiet default and says nothing; `auto` is one step away from
 * the mode that asks every time, so it is a warning; `bypass` gives the agent
 * everything and is the only mode painted as an error.
 */
export const PERMISSION_MODE_TOKENS: Readonly<Record<TuiPermissionMode, ThemeToken>> = {
  ask: 'muted',
  auto: 'warning',
  bypass: 'error',
};

/** The badge as the footer draws it: the mode, and how to cycle it. */
export interface PermissionBadge {
  /** The mode's own text, e.g. `[bypass]`. */
  readonly plain: string;
  /** The theme token that carries the mode's weight. */
  readonly token: ThemeToken;
  /**
   * The cycling hint, e.g. `· Shift+Tab`.
   *
   * Empty when the caller has no key to advertise. It is a separate segment
   * rather than part of `plain` so a narrow terminal can drop the hint and
   * keep the mode.
   */
  readonly hint: string;
}

/** The hint that names the key that cycles the mode. */
const CYCLE_HINT = '· Shift+Tab';

/** The hint shown while `bypass` waits for its second press. */
const CONFIRM_HINT = '· press Shift+Tab again';

/**
 * Build the badge for a mode.
 *
 * `staged` marks the moment where `bypass` has been asked for but not yet
 * confirmed: the badge then says what the second press will do, instead of
 * claiming a mode that is not in force yet.
 */
export function permissionBadge(
  mode: TuiPermissionMode,
  staged: boolean,
): PermissionBadge {
  return {
    plain: `[${mode}]`,
    token: PERMISSION_MODE_TOKENS[mode],
    hint: staged ? CONFIRM_HINT : CYCLE_HINT,
  };
}
