/**
 * `/display` — pick a shape for the transcript.
 *
 * ## Why this is a second menu over the same keys
 *
 * The renderer reads four orthogonal switches (`showThinking`, `expandBlocks`,
 * `showToolResults`, `toolGroupMode`) and `/settings` owns them individually.
 * That is the right place to tune ONE thing, and the wrong place to ask "give
 * me less" — four rows to move, with no name for the combination you meant.
 * `/display` supplies the names; the rows under them stay `/settings`' rows,
 * taken from the same state object rather than re-described, so the two menus
 * cannot disagree about what `Tool groups` currently says.
 *
 * ## Why choosing a profile writes four keys
 *
 * A profile is a vector, not a delta: writing only the switches that differ
 * would keep whatever an older build stored in the fourth, so "Standard" would
 * mean different transcripts on two installs. See `displayProfileSettings`.
 */

import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';
import type { TuiSettingsRow } from '../TUIApp.js';
import {
  SettingsState,
  TRANSCRIPT_SETTING_IDS,
  commitSettings,
  type SettingId,
} from './settings.js';
import { parseTuiPreferences, type TuiPreferences } from '../preferences.js';
import {
  DISPLAY_PROFILES,
  displayProfilePatch,
  displayProfileSettings,
  resolveDisplayProfile,
  type DisplayProfileId,
} from '../display-profiles.js';

/** `standard` and `Live only` both reach a profile; a table row does not. */
export type DisplayRowId = DisplayProfileId | SettingId;

function isProfileId(id: string): id is DisplayProfileId {
  return DISPLAY_PROFILES.some((profile) => profile.id === id);
}

/**
 * The list: four named vectors, then the switches they are made of.
 *
 * The current profile is marked rather than sorted to the top: a reader who
 * wants to know "which one am I on" is scanning, and a marker in the value
 * column is one lookup. A hand-tuned transcript marks none of them, which is
 * the honest answer — see `resolveDisplayProfile`.
 */
export function displayRows(state: SettingsState): readonly TuiSettingsRow[] {
  const current = resolveDisplayProfile({
    showThinking: state.live.showThinking,
    expandBlocks: state.live.expandBlocks,
    showToolResults: state.live.showToolResults,
    toolGroupMode: state.live.toolGroupMode,
  });
  const profiles = DISPLAY_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    valueLabel: profile.id === current ? 'Current' : '',
    detail: profile.detail,
  }));
  const rows = state.rows().filter((row) => (TRANSCRIPT_SETTING_IDS as readonly string[]).includes(row.id));
  return [...profiles, ...rows];
}

/** Apply a profile: the renderer moves now, the four keys get stored. */
function applyProfile(ctx: TuiSlashContext, state: SettingsState, id: DisplayProfileId): void {
  const patch = displayProfilePatch(id);
  state.preferences = { ...state.preferences, ...patch };
  state.live = { ...state.live, ...patch };
  commitSettings(ctx, { patch, settings: displayProfileSettings(id) });
}

/** `/display compact` — the same change the list makes, without opening it. */
function profileFromArgs(args: string): DisplayProfileId | null {
  const wanted = args.trim().toLowerCase();
  if (wanted === '') return null;
  const match = DISPLAY_PROFILES.find(
    (profile) => profile.id === wanted || profile.label.toLowerCase() === wanted.replace(/\s+/gu, ' '),
  );
  return match?.id ?? null;
}

const DISPLAY_COMMAND: TuiSlashCommandDef = {
  name: 'display',
  description: 'Choose how much of the event stream the transcript shows',
  group: 'Settings',
  async run(ctx: TuiSlashContext, args: string): Promise<TuiSlashOutcome> {
    let saved: TuiPreferences;
    try {
      saved = parseTuiPreferences(await ctx.client.getSettings());
    } catch (error) {
      ctx.tui.printError(
        `Could not read TUI settings: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: 'handled' };
    }
    const state = new SettingsState(saved, ctx.tui.liveTuiPreferences?.() ?? {
      theme: saved.theme,
      showThinking: saved.showThinking,
      expandBlocks: saved.expandBlocks,
      showToolResults: saved.showToolResults,
      toolGroupMode: saved.toolGroupMode,
      completionRows: saved.completionRows,
      inputRows: saved.inputRows,
    }, ctx.session.model ?? '');

    const requested = profileFromArgs(args);
    if (requested === null && args.trim() !== '') {
      ctx.tui.printNotice(`Unknown display profile. Choose one of: ${DISPLAY_PROFILES.map((profile) => profile.id).join(', ')}.`);
      return { kind: 'handled' };
    }
    if (requested !== null) {
      applyProfile(ctx, state, requested);
      const profile = DISPLAY_PROFILES.find((entry) => entry.id === requested);
      ctx.tui.printNotice(`Display: ${profile?.label ?? requested}. ${profile?.detail ?? ''}`);
      return { kind: 'handled' };
    }

    if (ctx.tui.openSettings === undefined) {
      // No live list (a headless host): one pick, applied, done.
      const picked = await ctx.tui.choose('Display', DISPLAY_PROFILES.map((profile) => ({
        label: profile.label,
        value: profile.id,
      })));
      if (picked !== null && isProfileId(picked)) applyProfile(ctx, state, picked);
      return { kind: 'handled' };
    }

    await ctx.tui.openSettings({
      title: 'Display',
      rows: displayRows(state),
      footer: 'type to filter · Enter/Space change · Esc close',
      onActivate: (id) => {
        if (isProfileId(id)) applyProfile(ctx, state, id);
        else commitSettings(ctx, state.cycle(id as SettingId));
        return displayRows(state);
      },
    });
    return { kind: 'handled' };
  },
};

export const DISPLAY_COMMANDS: readonly TuiSlashCommandDef[] = [DISPLAY_COMMAND];
