/**
 * The CLI option table, in one place.
 *
 * `--print` and `--headless` are intercepted in `index.ts` before commander
 * reaches its own action handler (in those modes the trailing positional is a
 * prompt, not an interactive REPL). That interception used to parse arguments
 * with a SECOND, hand-rolled parser which knew only `--model`, `--cwd`/`-c`
 * and `--format` — so `-k`, `-u`, `-p` and `-w` were silently dropped in those
 * two modes, `--cwd` was assigned to both `baseUrl` and `workspace`, and
 * `--format` never appeared in `--help`.
 *
 * Extracting the declarations here means the interactive program and the
 * print/headless interception are driven by ONE option table, so the two
 * paths cannot drift. `createAgentProgram()` is also what the parity test
 * builds, so the test exercises the shipped declarations rather than a copy.
 */

// `@commander-js/extra-typings`, NOT `commander`: `cli/index.ts` uses the
// extra-typings build, and mixing the two produces two incompatible `Command`
// types (the plain build is generic). Same import as the existing CLI code.
import { Command } from '@commander-js/extra-typings';

/** Options every mode shares. */
export const AGENT_CLI_OPTIONS: ReadonlyArray<[flags: string, description: string, defaultValue?: string]> = [
  ['-k, --api-key <key>', 'API key for LLM provider'],
  ['-m, --model <model>', 'Model to use'],
  ['-u, --base-url <url>', 'Base URL for API'],
  ['-p, --provider <provider>', 'LLM provider protocol: anthropic or openai'],
  ['-w, --workspace <dir>', 'Workspace directory'],
  ['-t, --task <task>', 'Execute task and exit (non-interactive mode)'],
  ['--print', 'Print mode: single query and exit'],
  ['--headless', 'Headless mode: read from script file'],
  ['--script <path>', 'Script file path for headless mode'],
  // Reachable in both --print and --headless. It used to be handled by the
  // private parser and was therefore invisible in --help.
  ['--format <format>', 'Output format for --print/--headless: text, json, or markdown', 'text'],
  ['--continue [sessionId]', 'Continue a previous session (optional session ID)'],
  ['--resume [sessionId]', 'Resume a session (alias for --continue)'],
  ['--summary-provider <provider>', 'Provider for session search summarization: anthropic or openai'],
  ['--summary-api-key <key>', 'API key for session search summarization LLM'],
  ['--summary-model <model>', 'Model for session search summarization'],
  ['--summary-base-url <url>', 'Base URL for session search summarization LLM'],
];

/**
 * Build the agent CLI program carrying the shared option table.
 *
 * The action handler is attached by the caller (`index.ts` supplies
 * `runCLI`); tests use this without one, since they only exercise parsing.
 */
export function createAgentProgram(action?: (options: unknown) => void): Command {
  const program = new Command();
  program
    .name('duya')
    .description('DUYA Agent - AI Agent with tools and MCP support')
    .version('0.2.0');

  for (const [flags, description, defaultValue] of AGENT_CLI_OPTIONS) {
    if (defaultValue === undefined) {
      program.option(flags, description);
    } else {
      program.option(flags, description, defaultValue);
    }
  }

  if (action) program.action(action as never);
  return program;
}

/** Options parsed out of argv, as both modes consume them. */
export interface ParsedCliOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  provider?: string;
  workspace?: string;
  task?: string;
  print?: boolean;
  headless?: boolean;
  script?: string;
  format?: 'text' | 'json' | 'markdown';
  continue?: string | boolean;
  resume?: string | boolean;
  summaryProvider?: string;
  summaryApiKey?: string;
  summaryModel?: string;
  summaryBaseUrl?: string;
}

/**
 * Parse argv with commander's option table without invoking the action
 * handler. `operands` holds the positional arguments — the `--print` prompt.
 */
export function parseCliArgs(argv: string[]): {
  operands: string[];
  unknown: string[];
  options: ParsedCliOptions;
} {
  const program = createAgentProgram();
  const { operands, unknown } = program.parseOptions(argv);
  return { operands, unknown, options: program.opts() as ParsedCliOptions };
}