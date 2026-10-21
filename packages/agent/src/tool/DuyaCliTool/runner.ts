/**
 * packages/agent/src/tool/DuyaCliTool/runner.ts
 *
 * In-process invocation of CLI control-plane commands.
 *
 * Plan 99 §4.1: the runner no longer captures process.stdout /
 * process.stderr. It dispatches through `@duya/cli/contract`'s
 * `buildAgentRunner` (descriptor-driven) and lets the contract
 * formatter own text vs JSON rendering. The agent tool's
 * `data` field is the typed `body` from the HTTP response, not
 * a re-parsed stdout string.
 *
 * The contract is shipped in the same workspace as `@duya/agent`
 * (added as a peer dep). The agent never spawns a subprocess to
 * run the CLI; it dispatches in-process via the contract.
 */

import { buildAgentRunner, type CliInvocation, type CliRunResult } from '@duya/cli/contract';

export type { CliInvocation, CliRunResult };

// Build the shared resolver once at module load. It is pure data
// (no I/O), so doing this eagerly is safe and avoids per-invocation
// overhead.
const resolve = buildAgentRunner();

/**
 * Dispatch the parsed invocation to the matching run* function.
 * Returns a structured result; never throws (failures are encoded
 * as non-zero exit codes, mirroring the CLI bundle contract).
 *
 * The contract runner does NOT touch process.stdout / process.stderr;
 * it returns the formatted text via the result envelope. The agent
 * tool's `execute()` decides what to do with stdout / stderr
 * (typically: surface them in the `data` field for structured
 * consumption, or pass them through to the agent's own logger for
 * human consumption).
 */
export async function runCliCommand(inv: CliInvocation): Promise<CliRunResult> {
  try {
    return await resolve(inv);
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `internal error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
