/**
 * packages/cli/src/index.ts
 *
 * DUYA desktop control plane — entry point for the bundled `duya`
 * wrapper script.
 *
 * This package is the *boundary* between the agent runtime
 * (`@duya/agent`) and the desktop app's localhost HTTP API. It does
 * NOT import any agent runtime (no `duyaAgent`, no `REPL`, no
 * `QueryEngine`, no `loadSkills`). It is a few hundred lines of
 * TypeScript that reads userData/runtime/cli-api.json, parses argv,
 * and dispatches HTTP calls to the desktop.
 *
 * The agent's `duya_cli` tool consumes the same `program/registry.ts`
 * + `program/build-agent-runner.ts` via `@duya/cli/contract`, so the
 * in-agent dispatch and the external CLI are guaranteed to share
 * the same command set.
 */

import { Command } from '@commander-js/extra-typings';
import { buildControlPlane } from './program/build-control-plane.js';

export { CLI_DESCRIPTORS } from './program/descriptors.js';
export type { CliCommandPath, ExitCode } from './program/registry.js';
export { buildAgentRunner, type CliInvocation, type CliRunResult } from './program/build-agent-runner.js';
export * from './contract/index.js';

/**
 * Build the `duya` Commander program. Pure function — no I/O,
 * no argv mutation. The caller (`bin/duya`) wires argv to
 * `program.parse(argv)`.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('duya')
    .description('DUYA desktop control plane (status, plugins, sessions, crons, channels, ...)')
    .version('0.1.0');
  buildControlPlane(program);
  return program;
}

// Standalone entry: when run as `node packages/cli/dist/index.js`,
// parse argv and dispatch.
if (
  // Detect "run as entry point" without `import.meta.url` shenanigans:
  // we are the entry if there's no parent module. This works for CJS
  // bundles (require.main === module) and for ESM bundles whose
  // bundle output is a single file.
  (typeof require !== 'undefined' && (require as { main?: unknown }).main === module) ||
  // ESM entry: process.argv[1] is the path that was executed. If
  // it resolves to this file, we are the entry.
  (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('index.js'))
) {
  const program = buildProgram();
  program.parse(process.argv);
}
