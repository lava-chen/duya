import type { StatuslineProfile } from '../preferences.js';
import { TUI_STATUSLINE_SETTING } from '../preferences.js';
import type { TuiSlashCommandDef } from './types.js';

const CHOICES: readonly { id: StatuslineProfile; label: string; detail: string }[] = [
  { id: 'full', label: 'Full', detail: 'Directory, branch, pull request, session, token usage, context, speed and model.' },
  { id: 'compact', label: 'Compact', detail: 'Directory, key hint, token usage, context and model.' },
  { id: 'location', label: 'Location', detail: 'Directory, branch, pull request, session and model.' },
  { id: 'usage', label: 'Usage', detail: 'Token usage, context, speed and model.' },
];

const STATUSLINE: TuiSlashCommandDef = {
  name: 'statusline',
  description: 'Choose which session details the footer shows',
  group: 'Settings',
  async run(ctx, args) {
    const wanted = args.trim().toLowerCase();
    let profile = CHOICES.find((choice) => choice.id === wanted)?.id;
    if (wanted !== '' && profile === undefined) {
      ctx.tui.printNotice(`Choose one of: ${CHOICES.map((choice) => choice.id).join(', ')}.`);
      return { kind: 'handled' };
    }
    if (profile === undefined) {
      const picked = await ctx.tui.choose('Status line', CHOICES.map(({ id, label, detail }) => ({
        value: id, label, description: detail,
      })));
      if (picked === null) return { kind: 'handled' };
      profile = picked as StatuslineProfile;
    }
    try {
      await ctx.client.setSetting(TUI_STATUSLINE_SETTING, profile);
      ctx.tui.applyTuiPreferences?.({ statusline: profile });
      ctx.tui.printNotice(`Status line: ${profile}.`);
    } catch (error) {
      ctx.tui.printError(`Could not save status line: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { kind: 'handled' };
  },
};

export const STATUSLINE_COMMANDS: readonly TuiSlashCommandDef[] = [STATUSLINE];
