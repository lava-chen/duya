/**
 * packages/host/src/diagnostics/index.ts
 *
 * The shared doctor layer.
 *
 * ## What is here and what is not
 *
 * HERE: the report shape, the checks, the renderers, and the ports the
 * surfaces fill in. THERE: the transport.
 *
 * The CLI asks a Host over HTTP; the Desktop asks itself in-process. The
 * checks are the same either way, which is the whole point of this package:
 * a bug report that says "cannot read plugin registry" means the same thing
 * whichever surface produced it.
 *
 * ## What this layer must never import
 *
 * No execution engine. `@duya/agent-core` / `@duya/agent-runtime` are
 * forbidden in anything a CLIENT entry point can reach — the CLI is a client
 * entry (gate G11-1), and a diagnostic that drags the runtime into the CLI
 * would undo the process boundary this repo spent six phases pulling apart.
 *
 * The layer's entire dependency list is `node:fs`, `node:os`, `node:path`,
 * `@iarna/toml` and its own relative modules. Keep it that way.
 */

export {
  DOCTOR_CATEGORIES,
  type CheckResult,
  type DoctorCategory,
  type DoctorIssue,
  type DoctorOverallStatus,
  type DoctorProfile,
  type DoctorResult,
  type DoctorStatus,
} from './types.js';

export { pushCheck, resetTiming } from './timing.js';

export { runConfigChecks } from './config-checks.js';

export {
  redactDoctorJson,
  redactPathInText,
  type RedactionOptions,
} from './redact.js';

export { renderDoctorPanel, renderText } from './render-text.js';

export {
  runOfflineDiagnostics,
  runRuntimeChecks,
  type DoctorRuntimeFact,
  type OfflineDiagnosticsOptions,
} from './offline.js';

export {
  runHostDiagnostics,
  type DoctorFact,
  type DoctorHostProbe,
  type DoctorPluginValue,
  type DoctorSessionValue,
  type DoctorStatusValue,
} from './host-facts.js';

export {
  DOCTOR_REPORT_VERSION,
  finalizeDoctorResult,
  runDiagnostics,
  type DiagnosticsOptions,
} from './run.js';
