/**
 * Plan 600 — typed surface for the boundary gates.
 *
 * ## The implementation lives in `boundary-gates.mjs`
 *
 * `tsx` is not a dependency of this repository, so a TypeScript file cannot be
 * the CLI entry point. Rather than add a devDependency to run one gate, the
 * detector logic is written once in plain ESM JavaScript and this file adds the
 * type annotations the unit tests rely on.
 *
 * There is no second implementation to drift: everything below re-exports from
 * the `.mjs`.
 *
 * ## What the gates are for
 *
 * `layer-purity.ts` (587 M5.3) already makes the `layers:` block mean something
 * for IO. What it does NOT check is the half plan 600 found to be load-bearing:
 * **the declared seam between runtime and its executor does not exist in
 * production.**
 *
 * `agent-runtime` owns `ExecutionChannel` as a port and the Desktop host
 * implements it, but the worker process that actually runs the model loop has no
 * implementation at all — `agent-process-entry.ts:75` imports `DuyaAgent` and
 * `:1923` constructs it, and the file contains zero references to
 * `ExecutionChannel`, `ExecutionSink` or `RunController`. The boundary is
 * declared in three packages and implemented in none on the execution path.
 *
 * G4 reports that. It is RED on the current tree, which is correct: it reports a
 * real defect rather than a misconfiguration. G6 reports the same for
 * `session_id NOT NULL` on the durable tables.
 *
 * ## The discipline
 *
 * G1/G3/G4/G6 fail on NEW findings only; known ones live in a baseline file, so
 * a real defect does not block unrelated work but a regression still does. Every
 * rule was proven red by deliberately breaking its detector — see
 * `boundary-gates.test.ts`, whose negative cases assert on fixtures rather than
 * on the live tree.
 */

export {
  BASELINE_PATH,
  DURABLE_IDENTITY_TABLES,
  DEAD_TABLE_DEFINITIONS,
  HOST_ONLY,
  LAYERS,
  SUBPATH_LAYERS,
  WORKER_ENTRY,
  collectBoundaryReport,
  databaseOfFile,
  evaluate,
  findReverseEdges,
  findRuntimeHostLeaks,
  findSessionRootedTables,
  findWorkerSeamBypasses,
  fingerprint,
  layerOfSpecifier,
  rel,
  workerImplementsExecutionChannel,
  writeBaseline,
} from './boundary-gates.mjs';

export type Database = 'core.db' | 'main.db';

export interface LayerDef {
  readonly name: string;
  readonly packages: readonly string[];
}

export interface ReverseEdge {
  readonly file: string;
  readonly from: string;
  /** The full import specifier, not the owning package: with sub-path layer overrides the two differ. */
  readonly to: string;
  readonly fromLayer: string;
  readonly toLayer: string;
}

export interface HostLeak {
  readonly file: string;
  readonly why: string;
}

export interface WorkerSeamFinding {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly why: string;
}

export interface SessionRootedTable {
  readonly table: string;
  readonly file: string;
  readonly line: number;
  readonly column: string;
  readonly database: Database;
  /** False for a DDL block nothing reads or writes. */
  readonly live: boolean;
}

export interface BoundaryReport {
  readonly gate: string;
  readonly title: string;
  readonly findings: readonly unknown[];
}

export interface GateOutcome {
  readonly gate: string;
  readonly title: string;
  readonly known: number;
  readonly newFindings: string[];
  /** Baseline entries no longer produced — a fix, to be pruned deliberately. */
  readonly stale: string[];
}
