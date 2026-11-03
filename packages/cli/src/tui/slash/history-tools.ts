import type { TuiSlashCommandDef } from './types.js';

const SEARCH: TuiSlashCommandDef = {
  name: 'search',
  description: 'Search messages in the visible transcript',
  group: 'Session info',
  async run(ctx, args) {
    const query = args || await ctx.tui.promptText?.('Search transcript', { placeholder: 'Search text' }) || '';
    if (!query.trim()) return { kind: 'handled' };
    const lines = ctx.actions?.searchTranscript?.(query) ?? [];
    ctx.tui.showPanel?.(`Search: ${query}`, lines.length > 0 ? lines : ['No matching messages.'], {
      footer: `${lines.length} match${lines.length === 1 ? '' : 'es'} · Esc close`,
      scrollable: true,
    });
    return { kind: 'handled' };
  },
};

const BACKTRACK: TuiSlashCommandDef = {
  name: 'backtrack',
  description: 'Copy the last prompt into the composer for editing',
  group: 'Session ops',
  async run(ctx, args) {
    if (args.trim()) {
      ctx.tui.printNotice('Use /backtrack to edit the latest submitted prompt.');
      return { kind: 'handled' };
    }
    const edited = ctx.actions?.editPreviousPrompt?.() ?? false;
    ctx.tui.printNotice(edited
      ? 'Previous prompt copied into the composer. Edit it, then submit to add a new turn.'
      : 'There is no submitted prompt to edit.');
    return { kind: 'handled' };
  },
};

export const HISTORY_TOOLS_COMMANDS: readonly TuiSlashCommandDef[] = [SEARCH, BACKTRACK];
