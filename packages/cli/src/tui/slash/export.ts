/**
 * packages/cli/src/tui/slash/export.ts
 *
 * `/export [directory]` — write the session's durable history to disk.
 *
 * The work is the Host's, not the CLI's: `exportRollout` serializes the
 * authoritative transcript server-side, so the exported file cannot drift from
 * what the Host would replay after a crash. The CLI only supplies an optional
 * destination directory and prints where the file landed.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';

const EXPORT_COMMAND: TuiSlashCommandDef = {
  name: 'export',
  argsHint: '[directory]',
  description: 'Export this session transcript to disk',
  group: 'Export',
  async run(ctx: TuiSlashContext, args: string) {
    const destination = args.trim();
    if (destination !== '') {
      // Fail loudly on a typo rather than letting the Host pick a default the
      // user did not ask for.
      try {
        const { statSync } = await import('node:fs');
        if (!statSync(destination).isDirectory()) {
          ctx.tui.printError(`Not a directory: ${destination}`);
          return { kind: 'handled' };
        }
      } catch (error) {
        ctx.tui.printError(
          `Cannot use ${destination || '(empty)'}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { kind: 'handled' };
      }
    }

    try {
      const result = await ctx.client.exportRollout(
        ctx.session.id,
        destination === '' ? undefined : destination,
      );
      ctx.tui.printNotice(`Exported ${result.lines} lines (${result.bytes} bytes) to:`);
      ctx.tui.printNotice(`  ${result.absolutePath}`);
    } catch (error) {
      ctx.tui.printError(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { kind: 'handled' };
  },
};

export const EXPORT_COMMANDS: readonly TuiSlashCommandDef[] = [EXPORT_COMMAND];
