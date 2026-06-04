/**
 * packages/agent/src/cli/program/build-control-plane.ts
 *
 * Mounts the descriptor-driven CLI control plane onto an existing
 * Commander program (the one `cli/index.ts` already constructed with
 * the legacy `-t` / `--print` / `--headless` flags).
 *
 * Plan 98 replaces the ~300-line inline `.command(...).action(...)`
 * block that used to live at the bottom of `cli/index.ts`. Adding a
 * new top-level command is now: edit `descriptors.ts` only.
 */

import { Command } from '@commander-js/extra-typings';
import { CLI_DESCRIPTORS } from './descriptors.js';
import { type CliSubcommand, type CliSubcommandContext } from './registry.js';

function buildOptions(cmd: Command, sub: CliSubcommand): void {
  for (const opt of sub.options ?? []) {
    cmd.option(opt.flags, opt.description);
  }
  if (sub.pagination) {
    cmd.option('--limit <n>', 'Page size');
    cmd.option('--offset <n>', 'Page offset');
  }
}

function buildArgs(cmd: Command, sub: CliSubcommand): void {
  for (const arg of sub.args ?? []) {
    if (arg.required) {
      cmd.argument(`<${arg.name}>`, arg.description);
    } else {
      cmd.argument(`[${arg.name}]`, arg.description);
    }
  }
}

/**
 * Mount descriptor-driven commands onto `program` (in-place mutation).
 * Preserves any commands already on `program` (legacy `-t` / `--print` /
 * `--headless` / `config` / `setup`).
 */
export function buildControlPlane(program: Command): void {
  for (const desc of CLI_DESCRIPTORS) {
    const top = new Command(desc.name).description(desc.description);
    program.addCommand(top);

    if (!desc.subcommands) continue;

    for (const [subName, sub] of Object.entries(desc.subcommands)) {
      // Single-subcommand commands (status, doctor, install-cli, etc.)
      // expose their only sub at the top level so `duya status` works
      // (not just `duya status default`).
      const exposedName = subName === 'default' ? desc.name : subName;

      const subCmd = new Command(exposedName).description(sub.description);
      buildArgs(subCmd, sub);
      buildOptions(subCmd, sub);

      subCmd.action(async (...actionArgs: unknown[]) => {
        // Commander's action signature is (args..., opts, command).
        // With `@commander-js/extra-typings`, opts is the 2nd-to-last.
        const opts = actionArgs[actionArgs.length - 2] as Record<string, unknown>;
        const userArgs = actionArgs.slice(0, -2) as string[];

        const ctx: CliSubcommandContext = {
          args: userArgs,
          format: opts.format === 'json' ? 'json' : 'text',
          options: {
            yes: opts.yes === true,
            limit: typeof opts.limit === 'string' ? opts.limit : undefined,
            offset: typeof opts.offset === 'string' ? opts.offset : undefined,
            fromFile: typeof opts.fromFile === 'string' ? opts.fromFile : undefined,
            // Plan 99 P3: inline cron body (avoids needing a temp file)
            cron: typeof opts.cron === 'string' ? opts.cron : undefined,
            prompt: typeof opts.prompt === 'string' ? opts.prompt : undefined,
            platform: typeof opts.platform === 'string' ? opts.platform : undefined,
          },
        };
        const code = await sub.run(ctx);
        if (code !== 0) process.exit(code);
      });

      top.addCommand(subCmd);
    }
  }
}
