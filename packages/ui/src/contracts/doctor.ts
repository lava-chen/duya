// Shared doctor / init vocabulary for the Desktop.
//
// The shapes live in `@duya/agent-protocol` — the contract package both the
// renderer and the host depend on — and this file re-exports them under the
// names the desktop code already uses.
//
// ## Why the contract package and not `@duya/host`
//
// The Host's diagnostics layer (`packages/host/src/diagnostics/`) owns the
// CHECKS and lives in the host package, which the renderer cannot import: the
// shared renderer package does not depend on it, and the browser-closure gate
// seeds `packages/ui/src`. The payload the renderer receives therefore has to
// be described somewhere the renderer can reach, and `@duya/agent-protocol` is
// exactly that place — it is a contract package with no runtime dependencies.
//
// ## Why the aliases
//
// `CheckResult` and `DoctorResult` are the contract's names. The desktop code
// grew up with `DoctorCheck` and `DoctorReport`, and the aliases keep that
// code readable without forking the shape. The alias and the original name
// are the same type, so nothing can drift between them.

export type {
  CheckResult,
  DoctorCategory,
  DoctorIssue,
  DoctorOverallStatus,
  DoctorProfile,
  DoctorResult,
  DoctorStatus,
  DoctorSummary,
  HostAgentsMdApiV1,
  InitAgentsMdResult,
} from '@duya/agent-protocol/doctor';

export { DOCTOR_CATEGORIES } from '@duya/agent-protocol/doctor';

/** The contract's `CheckResult`, under the name the desktop code uses. */
export type { CheckResult as DoctorCheck } from '@duya/agent-protocol/doctor';

/** The contract's `DoctorResult`, under the name the desktop code uses. */
export type { DoctorResult as DoctorReport } from '@duya/agent-protocol/doctor';
