/**
 * Compat forwarding layer -- the implementation moved to `@duya/agent-runtime`.
 *
 * ## Why this file still exists
 *
 * Executing one assembled run and settling its terminal is a RUNTIME concern:
 * the module speaks only the protocol and the runtime's own engine ports. It
 * now lives at `packages/agent-runtime/src/engine/run-engine-execution.ts`,
 * and this module keeps the `@duya/host/run-engine-execution` subpath working
 * for the consumers that still import it from here.
 *
 * Delete it once the consumers are zero -- not before, because the public
 * subpath is part of the Host's published surface.
 */

export { executeRunEngine } from '@duya/agent-runtime';
export type {
  ExecuteRunEngineOptions,
  RunEngineExecutionResult,
} from '@duya/agent-runtime';
