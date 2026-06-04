/**
 * packages/cli/src/contract/index.ts
 *
 * Public contract surface that `@duya/agent` (specifically
 * `tool/DuyaCliTool/`) imports to dispatch a CLI control-plane
 * invocation.
 *
 * The contract is intentionally minimal:
 *   - `CLI_DESCRIPTORS` — the frozen command + subcommand enum.
 *   - `CliCommandPath` — the auto-derived top-level path union.
 *   - `CliInvocation`  — the normalized invocation shape.
 *   - `CliRunResult`   — the structured result envelope.
 *   - `runCliCommand`  — the in-process dispatcher. In the agent
 *     subprocess mode this calls `buildAgentRunner` (descriptor
 *     dispatch with stdout/stderr capture). In the in-process /
 *     bundled-in-main mode this calls the same handlers the
 *     HTTP server would route to.
 *   - `buildControlPlaneClient` — the transport-agnostic client
 *     used by the contract dispatcher. Plan 99 §4.1: this is the
 *     single entry that both the `duya` CLI bundle and the
 *     `duya_cli` agent tool share, replacing the bespoke
 *     `DuyaCliTool/runner.ts` stream-capture.
 *
 * Hard rule: this module MUST NOT import any agent runtime
 * (no `duyaAgent`, no `REPL`, no `loadSkills`, no
 * `session/db.ts`). It is the boundary; agent tools reach through
 * it to the desktop control plane, not into the agent's internals.
 */

export { CLI_DESCRIPTORS } from '../program/descriptors.js';
export {
  type CliCommandDescriptor,
  type CliSubcommand,
  type CliSubcommandArg,
  type CliSubcommandOption,
  type CliSubcommandContext,
  type CliSubcommandOptions,
  type CliDescriptorSet,
  type ExitCode,
  resolveSubcommand,
  listCommandNames,
  listSubcommandNames,
  defineDescriptors,
} from '../program/registry.js';

export type { OutputFormat } from '../api/format.js';
export { parseFormat } from '../api/format.js';

export type { CliCommandPath } from '../program/registry.js';

export { buildAgentRunner } from '../program/build-agent-runner.js';
export type { CliInvocation, CliRunResult } from '../program/build-agent-runner.js';
