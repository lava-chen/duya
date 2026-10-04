/**
 * research-rows.ts - the persisted shapes of the research artifact family.
 *
 * These live apart from `session/db.ts` on purpose. The IPC client
 * (`ipc/db-client.ts`) has to name these row shapes in order to normalise the
 * main process's camelCase DTOs into what the local branch returns from
 * `SELECT *`, and `session/db.ts` already imports that client. Declaring the
 * types here and importing them from both sides keeps the edge one-directional:
 *
 *   ipc/db-client.ts ──> session/research-rows.ts <── session/db.ts
 *                                                 session/db.ts ──> ipc/db-client.ts
 *
 * Declaring them in `session/db.ts` instead makes that last edge cyclic at the
 * source level. `import type` is erased at build time so nothing breaks at
 * runtime, but `scripts/architecture/architecture-check.mjs` reads the source
 * import graph and does not distinguish type-only imports from value ones — and
 * correctly so, because a type-only edge still constrains where you may move
 * code later.
 */

/** Research activity row */
export interface ResearchActivityRow {
  id: string;
  run_id: string;
  sequence: number;
  kind: string;
  title: string;
  detail: string | null;
  visibility: 'user' | 'debug';
  created_at: number;
}

/** Persisted user-facing research event for replay and recovery. */
export interface ResearchEventRow {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  visibility: 'user' | 'debug';
  created_at: number;
}

/** Canonical source row for a research run. */
export interface ResearchSourceRow {
  id: string;
  run_id: string;
  title: string;
  url: string | null;
  canonical_url: string | null;
  source_type: string;
  allowed_by_policy: number;
  reliability_json: string | null;
  dedupe_key: string | null;
  rejected_reason: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

/** Citation edge from a report claim back to a source/finding. */
export interface ResearchCitationRow {
  id: string;
  run_id: string;
  report_id: string | null;
  source_id: string;
  finding_id: string | null;
  claim: string;
  locator_json: string | null;
  quoted_evidence: string | null;
  created_at: number;
}

/** Final report artifact for a research run. */
export interface ResearchReportRow {
  id: string;
  run_id: string;
  title: string | null;
  markdown: string;
  outline_json: string | null;
  source_ids_json: string;
  citation_ids_json: string;
  activity_summary_json: string | null;
  export_metadata_json: string | null;
  created_at: number;
  updated_at: number;
}
