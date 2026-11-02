/**
 * Compat forwarding layer -- the implementation moved to `@duya/agent-runtime`.
 *
 * ## Why this file still exists
 *
 * The tool side effect ledger is the run's durable record of which tool
 * attempts were made, and it is a RUNTIME concern: it speaks the protocol's
 * fence and attempt vocabulary, not the Host's. It now lives at
 * `packages/agent-runtime/src/engine/tool-side-effect-ledger.ts`, and this
 * module keeps the `@duya/host/worker-tool-ledger` subpath working for the
 * consumers that still import it from here.
 *
 * Delete it once the consumers are zero -- not before, because the public
 * subpath is part of the Host's published surface.
 */

export {
  createToolSideEffectLedger,
  defaultLedgerDir,
  ledgerFile,
} from '@duya/agent-runtime';
export type { LedgerOptions } from '@duya/agent-runtime';
