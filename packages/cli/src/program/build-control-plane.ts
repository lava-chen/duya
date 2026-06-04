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
  const seen = new Set<string>();
  const declared = (opt: { flags: string; description: string }): void => {
    // Dedup by the leading `--name` of the flag spec so the
    // descriptor's explicit `--limit` is not re-registered when
    // `pagination: true` also adds it. Commander 14 throws on
    // duplicate registration; the descriptor wins.
    const head = opt.flags.split(/\s|<|=>/)[0] ?? opt.flags;
    if (seen.has(head)) return;
    seen.add(head);
    cmd.option(opt.flags, opt.description);
  };
  for (const opt of sub.options ?? []) declared(opt);
  if (sub.pagination) {
    declared({ flags: '--limit <n>', description: 'Page size' });
    declared({ flags: '--offset <n>', description: 'Page offset' });
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
            // Plan 102 — `duya config` argv surface. Commander's
            // generic option pass-through means all the new flags
            // are already in `opts`; we just re-type them.
            configId: typeof opts.id === 'string' ? opts.id : undefined,
            configName: typeof opts.name === 'string' ? opts.name : undefined,
            configType: typeof opts.type === 'string' ? opts.type : undefined,
            configBaseUrl: typeof opts.baseUrl === 'string' ? opts.baseUrl : undefined,
            configApiKey: typeof opts.apiKey === 'string' ? opts.apiKey : undefined,
            configActive: opts.active === true,
            configEnabled: opts.enabled === true,
            configModel: typeof opts.model === 'string' ? opts.model : undefined,
            configProvider: typeof opts.provider === 'string' ? opts.provider : undefined,
            configMaxTokens: typeof opts.maxTokens === 'string' ? opts.maxTokens : undefined,
            configTemperature: typeof opts.temperature === 'string' ? opts.temperature : undefined,
            configTopP: typeof opts.topP === 'string' ? opts.topP : undefined,
            configTopK: typeof opts.topK === 'string' ? opts.topK : undefined,
            configEnableThinking: opts.enableThinking === true,
            configThinkingBudget: typeof opts.thinkingBudget === 'string' ? opts.thinkingBudget : undefined,
            configCode: typeof opts.code === 'string' ? opts.code : undefined,
            configUser: typeof opts.user === 'string' ? opts.user : undefined,
            configStyleId: typeof opts.styleId === 'string' ? opts.styleId : undefined,
            configInclude: typeof opts.include === 'string' ? opts.include : undefined,
            configArgs: Array.isArray(opts.arg) ? (opts.arg as string[]) : undefined,
            configEnv: Array.isArray(opts.env) ? (opts.env as string[]) : undefined,
            configAgents: Array.isArray(opts.agent) ? (opts.agent as string[]) : undefined,
          },
        };
        const code = await sub.run(ctx);
        if (code !== 0) process.exit(code);
      });

      top.addCommand(subCmd);
    }
  }
}
