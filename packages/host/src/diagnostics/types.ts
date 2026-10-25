/**
 * packages/host/src/diagnostics/types.ts
 *
 * The report shape every surface that runs a doctor check agrees on.
 *
 * ## Where the shape is defined
 *
 * In `@duya/agent-protocol` — the contract package. The renderer cannot
 * import `@duya/host` (the shared renderer package does not depend on it, and
 * the browser-closure gate seeds `packages/ui/src`), so the shape the
 * renderer receives has to live somewhere the renderer can reach. Defining it
 * once, in the contract package, is what makes "the desktop and the cli say
 * the same thing about the same install" a compile-time fact instead of a
 * convention: the host checks, the desktop adapter and the renderer all read
 * the same types.
 *
 * ## Why the category list is the single source of truth
 *
 * `CheckResult.category` used to be a hand-written union that included
 * `'database'`, while the text renderer grouped by a SEPARATE, shorter
 * hand-written list that did not. A check whose category was in the union but
 * not in the render list did not render badly — it did not render AT ALL. It
 * vanished from the report with no trace, which is the worst possible failure
 * for a diagnostic.
 *
 * The union is DERIVED from the list:
 *
 *   DOCTOR_CATEGORIES  →  DoctorCategory = typeof DOCTOR_CATEGORIES[number]
 *
 * so a category that is not listed does not exist, and a category that is
 * listed is always rendered. The two can no longer disagree, because there is
 * only one of them.
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
  type DoctorSummary,
} from '@duya/agent-protocol/doctor';
