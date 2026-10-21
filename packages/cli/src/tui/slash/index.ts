/**
 * packages/cli/src/tui/slash/index.ts
 *
 * Public surface of the TUI slash-command module. `chat.ts` imports from
 * here and nothing deeper — the per-command files stay private so a command
 * can move without touching the dispatch site.
 */

export type {
  TuiSlashActions,
  TuiSlashCommandDef,
  TuiSlashContext,
  TuiSlashGroup,
  TuiSlashHost,
  TuiSlashOutcome,
} from './types.js';

export {
  TUI_SLASH_COMMANDS,
  buildSlashCompletionRows,
  buildSlashHelpSections,
  hasTuiSlashCommand,
  resolveTuiSlashCommand,
} from './registry.js';
