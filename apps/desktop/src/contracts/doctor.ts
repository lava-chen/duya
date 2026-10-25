// The doctor and init wire, re-exported from the contract package.
//
// The main process and the renderer must agree on the shape of a doctor
// report, and the shape is defined once in `@duya/agent-protocol` so that the
// renderer (which cannot import `@duya/host`) and the host (which owns the
// checks) talk about the same thing.

export type {
  CheckResult,
  CheckResult as DoctorCheck,
  DoctorCategory,
  DoctorIssue,
  DoctorOverallStatus,
  DoctorProfile,
  DoctorResult,
  DoctorResult as DoctorReport,
  DoctorStatus,
  DoctorSummary,
  InitAgentsMdResult,
} from '@duya/agent-protocol/doctor';

export { DOCTOR_CATEGORIES } from '@duya/agent-protocol/doctor';
