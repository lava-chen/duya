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
 * The production worker now enters through `@duya/cli` → `@duya/host` and
 * reaches the shared RunEngine; G4 guards that production closure. G6 tracks
 * durable tables whose identity still depends on `session_id`.
 *
 * G4 and G7 are clean on the current worker path. G6 still reports known
 * session-rooted table and lifecycle debt; the baseline prevents it from
 * blocking unrelated changes while keeping new findings visible.
 *
 * ## The discipline
 *
 * G1/G3/G4/G6 fail on NEW findings only; known G6 findings live in a baseline
 * file, so existing debt does not block unrelated work but regressions do.
 * Every rule was proven red by deliberately breaking its detector — see
 * `boundary-gates.test.ts`, whose negative cases assert on fixtures rather than
 * on the live tree.
 */

export {
  BASELINE_PATH,
  DURABLE_IDENTITY_TABLES,
  DEAD_TABLE_DEFINITIONS,
  EXECUTION_OWNER_PACKAGE,
  HOST_DB_DIR,
  HOST_ONLY,
  IO_PRIMITIVES,
  LAYERS,
  LIFECYCLE_COUPLINGS,
  SUBPATH_LAYERS,
  TURN_LOOP_SHAPE,
  WORKER_ENTRY,
  collectBoundaryReport,
  databaseOfFile,
  evaluate,
  findCoreIoReach,
  findLifecycleCouplings,
  findLoopMisownership,
  findReverseEdges,
  findRuntimeHostLeaks,
  findSessionRootedTables,
  findWorkerLoopReach,
  findWorkerSeamBypasses,
  fingerprint,
  ioPrimitivesIn,
  isTestPath,
  isTurnLoopModule,
  layerOfSpecifier,
  reachabilityFrom,
  rel,
  resolveRepoSpecifier,
  sourceLayerOf,
  turnLoopSites,
  workerReachesRunEngine,
  writeBaseline,
} from './boundary-gates.mjs';

export type Database = 'core.db' | 'main.db';

/** How tightly a coupling rule is allowed to match. See `LIFECYCLE_COUPLINGS`. */
export type CouplingScope = 'file' | 'statement-table';

export interface LifecycleCouplingRule {
  readonly id: string;
  readonly scope: CouplingScope;
  readonly re: RegExp;
  readonly why: string;
}

export interface LifecycleCoupling {
  /** The durable table this exact statement names; null for `scope: 'file'` rules. */
  readonly table: string | null;
  /** Every durable table the containing file declares, so a null stays readable. */
  readonly scopedTo: string;
  readonly file: string;
  readonly coupling: string;
  readonly column: string;
  readonly database: Database;
}

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

/** G7 — a loop implementation the worker entry can still reach. */
export interface WorkerLoopReach {
  readonly file: string;
  /** The worker entry the closure was walked from. */
  readonly from: string;
  /** The module on the shortest discovered path to `file`. */
  readonly via: string;
  readonly why: string;
}

/** G8 — a package that still holds a turn-loop implementation. */
export interface LoopMisownership {
  /** The package's `src` root, which is the subject the key is built on. */
  readonly file: string;
  /** The package, as named in its `package.json`. */
  readonly table: string;
  readonly to: string;
  readonly owners: readonly string[];
}

/** G9 — an IO-performing module reachable from a `core` package's entry. */
export interface CoreIoReach {
  readonly file: string;
  /** The `core` package the reachability was measured from. */
  readonly from: string;
  /** The sorted, `+`-joined IO primitives the module calls. */
  readonly to: string;
  readonly why: string;
}

export interface BoundaryReport {
  readonly gate: string;
  readonly title: string;
  /**
   * Mutable on purpose. `scripts/` is in no `typecheck:*` project, so this file
   * is checked by nothing in the repo's gates and the four `evaluate(reports)`
   * call sites in the test file were failing a standalone `tsc --strict` run
   * against a `readonly` array while `evaluate`'s inferred parameter is mutable.
   * `unknown[]` is both narrower than the `any[]` inference it replaces and
   * true: every finding array here is built by `push`.
   */
  findings: unknown[];
}

export interface GateOutcome {
  readonly gate: string;
  readonly title: string;
  readonly known: number;
  readonly newFindings: string[];
  /** Baseline entries no longer produced — a fix, to be pruned deliberately. */
  readonly stale: string[];
}
