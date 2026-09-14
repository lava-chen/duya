/**
 * research-store.ts — ResearchStore aggregate for `duya-core.db`.
 *
 * Migrations target the Research subsystem tables migrated from duya-main.db:
 *   - Migration 22: research_projects, research_project_states,
 *                   research_memory_objects, research_hypotheses,
 *                   research_memory_candidates, research_memory_relations
 *   - Migration 23: import_batches, import_items
 *   - Migration 24: research_sessions, research_plan_steps, research_activities,
 *                   research_events, research_sources, research_reports,
 *                   research_citations
 *
 * Covers all CRUD operations for the deep-research subsystem (Plan 423).
 */

import { randomUUID } from 'node:crypto';
import type { Migration, SqliteDatabase } from './database';

// ─── Row Types ───────────────────────────────────────────────────────────────

interface ResearchSessionRow {
  id: string;
  session_id: string;
  original_query: string;
  clarification: string | null;
  context_json: string;
  status: string;
  current_phase: string;
  iterations: number;
  coverage: number;
  created_at: number;
  updated_at: number;
  title: string | null;
  run_status: string | null;
  plan_version: number;
  active_step_id: string | null;
  progress_summary: string | null;
  completed_at: number | null;
  error_json: string | null;
}

interface ResearchPlanStepRow {
  id: string;
  run_id: string;
  order_num: number;
  user_facing_label: string;
  internal_question_ids: string;
  status: string;
  started_at: number | null;
  completed_at: number | null;
}

interface ResearchActivityRow {
  id: string;
  run_id: string;
  sequence: number;
  kind: string;
  title: string;
  detail: string | null;
  visibility: string;
  created_at: number;
}

interface ResearchEventRow {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  visibility: string;
  created_at: number;
}

interface ResearchSourceRow {
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

interface ResearchReportRow {
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

interface ResearchCitationRow {
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

interface ResearchProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface ResearchProjectStateRow {
  project_id: string;
  state_json: string;
  updated_at: number;
}

interface ResearchMemoryObjectRow {
  id: string;
  project_id: string;
  type: string;
  content: string;
  summary: string | null;
  source_refs_json: string;
  relation_refs_json: string;
  valid_from: number | null;
  valid_to: number | null;
  status: string;
  confidence: number;
  importance: number;
  tags_json: string;
  embedding_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ResearchHypothesisRow {
  id: string;
  project_id: string;
  statement: string;
  status: string;
  supporting_evidence_ids_json: string;
  contradicting_evidence_ids_json: string;
  related_source_ids_json: string;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

interface ResearchMemoryCandidateRow {
  id: string;
  project_id: string;
  proposed_type: string;
  content: string;
  rationale: string;
  source_refs_json: string;
  confidence: number;
  status: string;
  created_by_session_id: string | null;
  created_at: number;
  reviewed_at: number | null;
}

interface ResearchMemoryRelationRow {
  id: string;
  project_id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: string;
  created_at: number;
}

interface ImportBatchRow {
  id: string;
  source: string;
  source_project_path: string | null;
  target_project_path: string | null;
  status: string;
  total_items: number;
  applied_items: number;
  created_at: number;
  rolled_back_at: number | null;
}

interface ImportItemRow {
  id: string;
  batch_id: string;
  source_type: string;
  source_path: string;
  source_hash: string | null;
  target_type: string;
  target_path: string;
  title: string;
  summary: string | null;
  risk_level: string;
  requires_auth: number;
  is_enabled: number;
  status: string;
  created_at: number;
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ResearchSession {
  id: string;
  sessionId: string;
  originalQuery: string;
  clarification: string | null;
  contextJson: string;
  status: string;
  currentPhase: string;
  iterations: number;
  coverage: number;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  runStatus: string | null;
  planVersion: number;
  activeStepId: string | null;
  progressSummary: string | null;
  completedAt: number | null;
  errorJson: string | null;
}

export interface ResearchPlanStep {
  id: string;
  runId: string;
  orderNum: number;
  userFacingLabel: string;
  internalQuestionIds: string[];
  status: string;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ResearchActivity {
  id: string;
  runId: string;
  sequence: number;
  kind: string;
  title: string;
  detail: string | null;
  visibility: string;
  createdAt: number;
}

export interface ResearchEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  payloadJson: string;
  visibility: string;
  createdAt: number;
}

export interface ResearchSource {
  id: string;
  runId: string;
  title: string;
  url: string | null;
  canonicalUrl: string | null;
  sourceType: string;
  allowedByPolicy: boolean;
  reliabilityJson: string | null;
  dedupeKey: string | null;
  rejectedReason: string | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchReport {
  id: string;
  runId: string;
  title: string | null;
  markdown: string;
  outlineJson: string | null;
  sourceIdsJson: string;
  citationIdsJson: string;
  activitySummaryJson: string | null;
  exportMetadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchCitation {
  id: string;
  runId: string;
  reportId: string | null;
  sourceId: string;
  findingId: string | null;
  claim: string;
  locatorJson: string | null;
  quotedEvidence: string | null;
  createdAt: number;
}

export interface ResearchProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchProjectState {
  projectId: string;
  stateJson: string;
  updatedAt: number;
}

export interface ResearchMemoryObject {
  id: string;
  projectId: string;
  type: string;
  content: string;
  summary: string | null;
  sourceRefsJson: string;
  relationRefsJson: string;
  validFrom: number | null;
  validTo: number | null;
  status: string;
  confidence: number;
  importance: number;
  tagsJson: string;
  embeddingJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchHypothesis {
  id: string;
  projectId: string;
  statement: string;
  status: string;
  supportingEvidenceIdsJson: string;
  contradictingEvidenceIdsJson: string;
  relatedSourceIdsJson: string;
  supersededBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchMemoryCandidate {
  id: string;
  projectId: string;
  proposedType: string;
  content: string;
  rationale: string;
  sourceRefsJson: string;
  confidence: number;
  status: string;
  createdBySessionId: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

export interface ResearchMemoryRelation {
  id: string;
  projectId: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: string;
  createdAt: number;
}

export interface ImportBatch {
  id: string;
  source: string;
  sourceProjectPath: string | null;
  targetProjectPath: string | null;
  status: string;
  totalItems: number;
  appliedItems: number;
  createdAt: number;
  rolledBackAt: number | null;
}

export interface ImportItem {
  id: string;
  batchId: string;
  sourceType: string;
  sourcePath: string;
  sourceHash: string | null;
  targetType: string;
  targetPath: string;
  title: string;
  summary: string | null;
  riskLevel: string;
  requiresAuth: boolean;
  isEnabled: boolean;
  status: string;
  createdAt: number;
}

export interface MemoryObjectWithEmbedding {
  id: string;
  projectId: string;
  content: string;
  summary: string | null;
  embeddingJson: string;
}

export interface AcceptCandidateResult {
  success: boolean;
  candidate: ResearchMemoryCandidate | null;
  memory: ResearchMemoryObject | null;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class ResearchStore {
  static readonly migrations: Migration[] = [
    {
      id: 22,
      name: 'create_research_memory_tables',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS research_projects (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            status      TEXT NOT NULL DEFAULT 'active',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_project_states (
            project_id  TEXT PRIMARY KEY,
            state_json  TEXT NOT NULL,
            updated_at  INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_memory_objects (
            id               TEXT PRIMARY KEY,
            project_id       TEXT NOT NULL,
            type             TEXT NOT NULL,
            content          TEXT NOT NULL,
            summary          TEXT,
            source_refs_json TEXT NOT NULL DEFAULT '[]',
            relation_refs_json TEXT NOT NULL DEFAULT '[]',
            valid_from       INTEGER,
            valid_to         INTEGER,
            status           TEXT NOT NULL DEFAULT 'active',
            confidence       REAL NOT NULL DEFAULT 0.5,
            importance       REAL NOT NULL DEFAULT 0.5,
            tags_json        TEXT NOT NULL DEFAULT '[]',
            embedding_json   TEXT,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_hypotheses (
            id                              TEXT PRIMARY KEY,
            project_id                      TEXT NOT NULL,
            statement                       TEXT NOT NULL,
            status                          TEXT NOT NULL DEFAULT 'proposed',
            supporting_evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
            contradicting_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            related_source_ids_json         TEXT NOT NULL DEFAULT '[]',
            superseded_by                   TEXT,
            created_at                      INTEGER NOT NULL,
            updated_at                      INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_memory_candidates (
            id                    TEXT PRIMARY KEY,
            project_id            TEXT NOT NULL,
            proposed_type         TEXT NOT NULL,
            content               TEXT NOT NULL,
            rationale             TEXT NOT NULL,
            source_refs_json      TEXT NOT NULL DEFAULT '[]',
            confidence            REAL NOT NULL DEFAULT 0.5,
            status                TEXT NOT NULL DEFAULT 'pending',
            created_by_session_id TEXT,
            created_at            INTEGER NOT NULL,
            reviewed_at           INTEGER,
            FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_memory_relations (
            id              TEXT PRIMARY KEY,
            project_id      TEXT NOT NULL,
            from_memory_id  TEXT NOT NULL,
            to_memory_id    TEXT NOT NULL,
            relation_type   TEXT NOT NULL,
            created_at      INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
          )
        `);

        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_objects_project ON research_memory_objects(project_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_objects_type ON research_memory_objects(type)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_hypotheses_project ON research_hypotheses(project_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_candidates_project ON research_memory_candidates(project_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_candidates_status ON research_memory_candidates(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_relations_from ON research_memory_relations(from_memory_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_relations_to ON research_memory_relations(to_memory_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_relations_project ON research_memory_relations(project_id)`);
      },
    },
    {
      id: 23,
      name: 'create_import_tables',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS import_batches (
            id                  TEXT PRIMARY KEY,
            source              TEXT NOT NULL,
            source_project_path TEXT,
            target_project_path TEXT,
            status              TEXT NOT NULL DEFAULT 'pending',
            total_items         INTEGER NOT NULL DEFAULT 0,
            applied_items       INTEGER NOT NULL DEFAULT 0,
            created_at          INTEGER NOT NULL,
            rolled_back_at      INTEGER
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS import_items (
            id             TEXT PRIMARY KEY,
            batch_id       TEXT NOT NULL REFERENCES import_batches(id),
            source_type    TEXT NOT NULL,
            source_path    TEXT NOT NULL,
            source_hash    TEXT,
            target_type    TEXT NOT NULL,
            target_path    TEXT NOT NULL,
            title          TEXT NOT NULL,
            summary        TEXT,
            risk_level     TEXT NOT NULL DEFAULT 'safe',
            requires_auth  INTEGER NOT NULL DEFAULT 0,
            is_enabled     INTEGER NOT NULL DEFAULT 1,
            status         TEXT NOT NULL DEFAULT 'imported',
            created_at     INTEGER NOT NULL
          )
        `);

        db.exec(`CREATE INDEX IF NOT EXISTS idx_import_items_batch ON import_items(batch_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_import_batches_project ON import_batches(target_project_path)`);
      },
    },
    {
      id: 24,
      name: 'create_research_session_tables',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS research_sessions (
            id               TEXT PRIMARY KEY,
            session_id       TEXT NOT NULL,
            original_query   TEXT NOT NULL,
            clarification    TEXT,
            context_json     TEXT NOT NULL DEFAULT '{}',
            status           TEXT NOT NULL DEFAULT 'active',
            current_phase    TEXT NOT NULL DEFAULT 'idle',
            iterations       INTEGER NOT NULL DEFAULT 0,
            coverage         REAL NOT NULL DEFAULT 0,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL,
            title            TEXT,
            run_status       TEXT,
            plan_version     INTEGER NOT NULL DEFAULT 0,
            active_step_id   TEXT,
            progress_summary TEXT,
            completed_at     INTEGER,
            error_json       TEXT,
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_plan_steps (
            id                  TEXT PRIMARY KEY,
            run_id              TEXT NOT NULL,
            order_num           INTEGER NOT NULL,
            user_facing_label   TEXT NOT NULL,
            internal_question_ids TEXT NOT NULL DEFAULT '[]',
            status              TEXT NOT NULL DEFAULT 'pending',
            started_at          INTEGER,
            completed_at        INTEGER,
            FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_activities (
            id         TEXT PRIMARY KEY,
            run_id     TEXT NOT NULL,
            sequence   INTEGER NOT NULL,
            kind       TEXT NOT NULL,
            title      TEXT NOT NULL,
            detail     TEXT,
            visibility TEXT NOT NULL DEFAULT 'user',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_events (
            id           TEXT PRIMARY KEY,
            run_id       TEXT NOT NULL,
            sequence     INTEGER NOT NULL,
            event_type   TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            visibility   TEXT NOT NULL DEFAULT 'user',
            created_at   INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE,
            UNIQUE(run_id, sequence)
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_sources (
            id                TEXT PRIMARY KEY,
            run_id            TEXT NOT NULL,
            title             TEXT NOT NULL,
            url               TEXT,
            canonical_url     TEXT,
            source_type       TEXT NOT NULL DEFAULT 'web',
            allowed_by_policy INTEGER NOT NULL DEFAULT 1,
            reliability_json  TEXT,
            dedupe_key        TEXT,
            rejected_reason   TEXT,
            metadata_json     TEXT,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_reports (
            id                     TEXT PRIMARY KEY,
            run_id                 TEXT NOT NULL,
            title                  TEXT,
            markdown               TEXT NOT NULL,
            outline_json           TEXT,
            source_ids_json        TEXT NOT NULL DEFAULT '[]',
            citation_ids_json      TEXT NOT NULL DEFAULT '[]',
            activity_summary_json  TEXT,
            export_metadata_json   TEXT,
            created_at             INTEGER NOT NULL,
            updated_at             INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE
          )
        `);

        db.exec(`
          CREATE TABLE IF NOT EXISTS research_citations (
            id              TEXT PRIMARY KEY,
            run_id          TEXT NOT NULL,
            report_id       TEXT,
            source_id       TEXT NOT NULL,
            finding_id      TEXT,
            claim           TEXT NOT NULL,
            locator_json    TEXT,
            quoted_evidence TEXT,
            created_at      INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES research_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE SET NULL,
            FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE CASCADE
          )
        `);

        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_session ON research_sessions(session_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sessions_status ON research_sessions(status)`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_research_events_run_seq ON research_events(run_id, sequence)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_plan_steps_run ON research_plan_steps(run_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_activities_run ON research_activities(run_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_activities_seq ON research_activities(run_id, sequence)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_events_run_seq ON research_events(run_id, sequence)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(run_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_sources_policy ON research_sources(run_id, allowed_by_policy)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_reports_run ON research_reports(run_id, updated_at DESC)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_citations_run ON research_citations(run_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_research_citations_report ON research_citations(report_id)`);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  createSession(input: {
    id: string;
    sessionId: string;
    originalQuery: string;
    clarification?: string | null;
    contextJson?: string;
    status?: string;
    title?: string | null;
    runStatus?: string | null;
  }): ResearchSession {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_sessions (
          id, session_id, original_query, clarification, context_json,
          status, current_phase, iterations, coverage, created_at, updated_at,
          title, run_status, plan_version, active_step_id, progress_summary, completed_at, error_json
        ) VALUES (
          @id, @session_id, @original_query, @clarification, @context_json,
          @status, 'idle', 0, 0, @created_at, @updated_at,
          @title, @run_status, 0, NULL, NULL, NULL, NULL
        )`,
      )
      .run({
        id: input.id,
        session_id: input.sessionId,
        original_query: input.originalQuery,
        clarification: input.clarification ?? null,
        context_json: input.contextJson ?? '{}',
        status: input.status ?? 'active',
        created_at: now,
        updated_at: now,
        title: input.title ?? null,
        run_status: input.runStatus ?? null,
      });
    return this.getSession(input.id)!;
  }

  getSession(id: string): ResearchSession | null {
    const row = this.db.prepare('SELECT * FROM research_sessions WHERE id = ?').get(id) as ResearchSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  getSessionBySessionId(sessionId: string): ResearchSession | null {
    const row = this.db
      .prepare('SELECT * FROM research_sessions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as ResearchSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  updateSession(id: string, patch: {
    clarification?: string | null;
    contextJson?: string;
    status?: string;
    currentPhase?: string;
    iterations?: number;
    coverage?: number;
    title?: string | null;
    runStatus?: string | null;
    planVersion?: number;
    activeStepId?: string | null;
    progressSummary?: string | null;
    completedAt?: number | null;
    errorJson?: string | null;
  }): ResearchSession | null {
    const sets: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: Date.now() };

    if (patch.clarification !== undefined) { sets.push('clarification = @clarification'); params.clarification = patch.clarification; }
    if (patch.contextJson !== undefined) { sets.push('context_json = @context_json'); params.context_json = patch.contextJson; }
    if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status; }
    if (patch.currentPhase !== undefined) { sets.push('current_phase = @current_phase'); params.current_phase = patch.currentPhase; }
    if (patch.iterations !== undefined) { sets.push('iterations = @iterations'); params.iterations = patch.iterations; }
    if (patch.coverage !== undefined) { sets.push('coverage = @coverage'); params.coverage = patch.coverage; }
    if (patch.title !== undefined) { sets.push('title = @title'); params.title = patch.title; }
    if (patch.runStatus !== undefined) { sets.push('run_status = @run_status'); params.run_status = patch.runStatus; }
    if (patch.planVersion !== undefined) { sets.push('plan_version = @plan_version'); params.plan_version = patch.planVersion; }
    if (patch.activeStepId !== undefined) { sets.push('active_step_id = @active_step_id'); params.active_step_id = patch.activeStepId; }
    if (patch.progressSummary !== undefined) { sets.push('progress_summary = @progress_summary'); params.progress_summary = patch.progressSummary; }
    if (patch.completedAt !== undefined) { sets.push('completed_at = @completed_at'); params.completed_at = patch.completedAt; }
    if (patch.errorJson !== undefined) { sets.push('error_json = @error_json'); params.error_json = patch.errorJson; }

    this.db.prepare(`UPDATE research_sessions SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getSession(id);
  }

  deleteSession(id: string): boolean {
    const r = this.db.prepare('DELETE FROM research_sessions WHERE id = ?').run(id);
    return r.changes > 0;
  }

  listSessions(limit = 100): ResearchSession[] {
    const rows = this.db.prepare('SELECT * FROM research_sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as ResearchSessionRow[];
    return rows.map(rowToSession);
  }

  listSessionsByStatus(status: string): ResearchSession[] {
    const rows = this.db
      .prepare('SELECT * FROM research_sessions WHERE status = ? ORDER BY updated_at DESC')
      .all(status) as ResearchSessionRow[];
    return rows.map(rowToSession);
  }

  getActiveRun(sessionId: string): ResearchSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM research_sessions
         WHERE session_id = ? AND run_status IN ('planning', 'awaiting_approval', 'running', 'paused', 'synthesizing')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as ResearchSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  listActiveRuns(): ResearchSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM research_sessions
         WHERE run_status IN ('planning', 'awaiting_approval', 'running', 'paused', 'synthesizing')
         ORDER BY updated_at DESC`,
      )
      .all() as ResearchSessionRow[];
    return rows.map(rowToSession);
  }

  // ─── Plan Steps ─────────────────────────────────────────────────────────────

  createSteps(runId: string, steps: Array<{
    id: string;
    orderNum: number;
    userFacingLabel: string;
    internalQuestionIds: string[];
  }>): ResearchPlanStep[] {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO research_plan_steps (id, run_id, order_num, user_facing_label, internal_question_ids, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    );
    const txn = this.db.transaction(() => {
      for (const step of steps) {
        stmt.run(step.id, runId, step.orderNum, step.userFacingLabel, JSON.stringify(step.internalQuestionIds));
      }
    });
    txn();
    return this.getPlanStepsByRunId(runId);
  }

  getPlanStepsByRunId(runId: string): ResearchPlanStep[] {
    const rows = this.db
      .prepare('SELECT * FROM research_plan_steps WHERE run_id = ? ORDER BY order_num ASC')
      .all(runId) as ResearchPlanStepRow[];
    return rows.map(rowToPlanStep);
  }

  updatePlanStep(stepId: string, patch: { status?: string; startedAt?: number | null; completedAt?: number | null }): ResearchPlanStep | null {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id: stepId };
    if (patch.status !== undefined) { fields.push('status = @status'); params.status = patch.status; }
    if (patch.startedAt !== undefined) { fields.push('started_at = @started_at'); params.started_at = patch.startedAt; }
    if (patch.completedAt !== undefined) { fields.push('completed_at = @completed_at'); params.completed_at = patch.completedAt; }
    if (fields.length === 0) return null;
    this.db.prepare(`UPDATE research_plan_steps SET ${fields.join(', ')} WHERE id = @id`).run(params);
    const row = this.db.prepare('SELECT * FROM research_plan_steps WHERE id = ?').get(stepId) as ResearchPlanStepRow | undefined;
    return row ? rowToPlanStep(row) : null;
  }

  deletePlanStepsByRunId(runId: string): void {
    this.db.prepare('DELETE FROM research_plan_steps WHERE run_id = ?').run(runId);
  }

  // ─── Activities ─────────────────────────────────────────────────────────────

  createActivity(input: {
    id: string;
    runId: string;
    sequence: number;
    kind: string;
    title: string;
    detail?: string | null;
    visibility?: string;
  }): ResearchActivity {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_activities (id, run_id, sequence, kind, title, detail, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.runId, input.sequence, input.kind, input.title, input.detail ?? null, input.visibility ?? 'user', now);
    return this.getActivity(input.id)!;
  }

  getActivity(id: string): ResearchActivity | null {
    const row = this.db.prepare('SELECT * FROM research_activities WHERE id = ?').get(id) as ResearchActivityRow | undefined;
    return row ? rowToActivity(row) : null;
  }

  getActivitiesByRunId(runId: string, opts?: { visibility?: string; limit?: number; afterSequence?: number }): ResearchActivity[] {
    const conditions: string[] = ['run_id = ?'];
    const params: unknown[] = [runId];

    if (opts?.visibility) { conditions.push('visibility = ?'); params.push(opts.visibility); }
    if (opts?.afterSequence !== undefined) { conditions.push('sequence > ?'); params.push(opts.afterSequence); }

    const limit = opts?.limit ?? 200;
    const rows = this.db
      .prepare(`SELECT * FROM research_activities WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC LIMIT ?`)
      .all(...params, limit) as ResearchActivityRow[];
    return rows.map(rowToActivity);
  }

  getMaxActivitySequence(runId: string): number {
    const result = this.db
      .prepare('SELECT MAX(sequence) as max_seq FROM research_activities WHERE run_id = ?')
      .get(runId) as { max_seq: number | null } | undefined;
    return result?.max_seq ?? 0;
  }

  deleteActivitiesByRunId(runId: string): void {
    this.db.prepare('DELETE FROM research_activities WHERE run_id = ?').run(runId);
  }

  // ─── Events ─────────────────────────────────────────────────────────────────

  createEvent(input: {
    id: string;
    runId: string;
    sequence: number;
    eventType: string;
    payloadJson: string;
    visibility?: string;
  }): ResearchEvent {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_events (id, run_id, sequence, event_type, payload_json, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.runId, input.sequence, input.eventType, input.payloadJson, input.visibility ?? 'user', now);
    const row = this.db.prepare('SELECT * FROM research_events WHERE run_id = ? AND sequence = ?').get(input.runId, input.sequence) as ResearchEventRow | undefined;
    return rowToEvent(row!);
  }

  getEventsByRunId(runId: string, opts?: { limit?: number; afterSequence?: number; visibility?: string }): ResearchEvent[] {
    const conditions: string[] = ['run_id = ?'];
    const params: unknown[] = [runId];

    if (opts?.visibility) { conditions.push('visibility = ?'); params.push(opts.visibility); }
    if (opts?.afterSequence !== undefined) { conditions.push('sequence > ?'); params.push(opts.afterSequence); }
    else { conditions.push('sequence > ?'); params.push(-1); }

    const limit = opts?.limit ?? 500;
    const rows = this.db
      .prepare(`SELECT * FROM research_events WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC LIMIT ?`)
      .all(...params, limit) as ResearchEventRow[];
    return rows.map(rowToEvent);
  }

  getMaxEventSequence(runId: string): number {
    const result = this.db
      .prepare('SELECT MAX(sequence) as max_seq FROM research_events WHERE run_id = ?')
      .get(runId) as { max_seq: number | null } | undefined;
    return result?.max_seq ?? 0;
  }

  // ─── Sources ────────────────────────────────────────────────────────────────

  upsertSource(input: {
    id: string;
    runId: string;
    title: string;
    url?: string | null;
    canonicalUrl?: string | null;
    sourceType?: string;
    allowedByPolicy?: boolean;
    reliabilityJson?: string | null;
    dedupeKey?: string | null;
    rejectedReason?: string | null;
    metadataJson?: string | null;
  }): ResearchSource {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_sources (
          id, run_id, title, url, canonical_url, source_type, allowed_by_policy,
          reliability_json, dedupe_key, rejected_reason, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          url = excluded.url,
          canonical_url = excluded.canonical_url,
          source_type = excluded.source_type,
          allowed_by_policy = excluded.allowed_by_policy,
          reliability_json = excluded.reliability_json,
          dedupe_key = excluded.dedupe_key,
          rejected_reason = excluded.rejected_reason,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.runId,
        input.title,
        input.url ?? null,
        input.canonicalUrl ?? input.url ?? null,
        input.sourceType ?? 'web',
        input.allowedByPolicy === false ? 0 : 1,
        input.reliabilityJson ?? null,
        input.dedupeKey ?? null,
        input.rejectedReason ?? null,
        input.metadataJson ?? null,
        now,
        now,
      );
    return this.getSource(input.id)!;
  }

  getSource(id: string): ResearchSource | null {
    const row = this.db.prepare('SELECT * FROM research_sources WHERE id = ?').get(id) as ResearchSourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  getSourcesByRunId(runId: string): ResearchSource[] {
    const rows = this.db
      .prepare('SELECT * FROM research_sources WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as ResearchSourceRow[];
    return rows.map(rowToSource);
  }

  // ─── Citations ──────────────────────────────────────────────────────────────

  createCitation(input: {
    id: string;
    runId: string;
    reportId?: string | null;
    sourceId: string;
    findingId?: string | null;
    claim: string;
    locatorJson?: string | null;
    quotedEvidence?: string | null;
  }): ResearchCitation {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO research_citations (
          id, run_id, report_id, source_id, finding_id, claim, locator_json, quoted_evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.reportId ?? null,
        input.sourceId,
        input.findingId ?? null,
        input.claim,
        input.locatorJson ?? null,
        input.quotedEvidence ?? null,
        now,
      );
    return this.getCitation(input.id)!;
  }

  getCitation(id: string): ResearchCitation | null {
    const row = this.db.prepare('SELECT * FROM research_citations WHERE id = ?').get(id) as ResearchCitationRow | undefined;
    return row ? rowToCitation(row) : null;
  }

  getCitationsByRunId(runId: string, reportId?: string): ResearchCitation[] {
    let rows: ResearchCitationRow[];
    if (reportId) {
      rows = this.db
        .prepare('SELECT * FROM research_citations WHERE run_id = ? AND report_id = ? ORDER BY created_at ASC')
        .all(runId, reportId) as ResearchCitationRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM research_citations WHERE run_id = ? ORDER BY created_at ASC')
        .all(runId) as ResearchCitationRow[];
    }
    return rows.map(rowToCitation);
  }

  // ─── Reports ────────────────────────────────────────────────────────────────

  upsertReport(input: {
    id: string;
    runId: string;
    title?: string | null;
    markdown: string;
    outlineJson?: string | null;
    sourceIdsJson?: string;
    citationIdsJson?: string;
    activitySummaryJson?: string | null;
    exportMetadataJson?: string | null;
  }): ResearchReport {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_reports (
          id, run_id, title, markdown, outline_json, source_ids_json, citation_ids_json,
          activity_summary_json, export_metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          markdown = excluded.markdown,
          outline_json = excluded.outline_json,
          source_ids_json = excluded.source_ids_json,
          citation_ids_json = excluded.citation_ids_json,
          activity_summary_json = excluded.activity_summary_json,
          export_metadata_json = excluded.export_metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.runId,
        input.title ?? null,
        input.markdown,
        input.outlineJson ?? null,
        input.sourceIdsJson ?? '[]',
        input.citationIdsJson ?? '[]',
        input.activitySummaryJson ?? null,
        input.exportMetadataJson ?? null,
        now,
        now,
      );
    return this.getReport(input.id)!;
  }

  getReport(id: string): ResearchReport | null {
    const row = this.db.prepare('SELECT * FROM research_reports WHERE id = ?').get(id) as ResearchReportRow | undefined;
    return row ? rowToReport(row) : null;
  }

  getLatestReport(runId: string): ResearchReport | null {
    const row = this.db
      .prepare('SELECT * FROM research_reports WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(runId) as ResearchReportRow | undefined;
    return row ? rowToReport(row) : null;
  }

  // ─── Projects ───────────────────────────────────────────────────────────────

  createProject(input: { id: string; name: string; description?: string | null }): ResearchProject {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_projects (id, name, description, created_at, updated_at)
         VALUES (@id, @name, @description, @created_at, @updated_at)`,
      )
      .run({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.getProject(input.id)!;
  }

  getProject(id: string): ResearchProject | null {
    const row = this.db.prepare('SELECT * FROM research_projects WHERE id = ?').get(id) as ResearchProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  listProjects(): ResearchProject[] {
    const rows = this.db.prepare('SELECT * FROM research_projects ORDER BY updated_at DESC').all() as ResearchProjectRow[];
    return rows.map(rowToProject);
  }

  updateProject(id: string, patch: { name?: string; description?: string | null; status?: string }): ResearchProject | null {
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: Date.now() };
    if (patch.name !== undefined) { fields.push('name = @name'); params.name = patch.name; }
    if (patch.description !== undefined) { fields.push('description = @description'); params.description = patch.description; }
    if (patch.status !== undefined) { fields.push('status = @status'); params.status = patch.status; }
    this.db.prepare(`UPDATE research_projects SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    const r = this.db.prepare('DELETE FROM research_projects WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Project States ─────────────────────────────────────────────────────────

  getProjectState(projectId: string): ResearchProjectState | null {
    const row = this.db.prepare('SELECT * FROM research_project_states WHERE project_id = ?').get(projectId) as ResearchProjectStateRow | undefined;
    return row ? rowToProjectState(row) : null;
  }

  upsertProjectState(projectId: string, stateJson: string): ResearchProjectState {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_project_states (project_id, state_json, updated_at)
         VALUES (@project_id, @state_json, @updated_at)
         ON CONFLICT(project_id) DO UPDATE SET state_json = @state_json, updated_at = @updated_at`,
      )
      .run({ project_id: projectId, state_json: stateJson, updated_at: now });
    return this.getProjectState(projectId)!;
  }

  // ─── Memory Objects ─────────────────────────────────────────────────────────

  createMemoryObject(input: {
    id: string;
    projectId: string;
    type: string;
    content: string;
    summary?: string | null;
    sourceRefs?: string[];
    relationRefs?: string[];
    validFrom?: number | null;
    validTo?: number | null;
    status?: string;
    confidence?: number;
    importance?: number;
    tags?: string[];
    embeddingJson?: string | null;
  }): ResearchMemoryObject {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_memory_objects (
          id, project_id, type, content, summary, source_refs_json, relation_refs_json,
          valid_from, valid_to, status, confidence, importance, tags_json,
          embedding_json, created_at, updated_at
        ) VALUES (
          @id, @project_id, @type, @content, @summary, @source_refs_json, @relation_refs_json,
          @valid_from, @valid_to, @status, @confidence, @importance, @tags_json,
          @embedding_json, @created_at, @updated_at
        )`,
      )
      .run({
        id: input.id,
        project_id: input.projectId,
        type: input.type,
        content: input.content,
        summary: input.summary ?? null,
        source_refs_json: JSON.stringify(input.sourceRefs ?? []),
        relation_refs_json: JSON.stringify(input.relationRefs ?? []),
        valid_from: input.validFrom ?? null,
        valid_to: input.validTo ?? null,
        status: input.status ?? 'active',
        confidence: input.confidence ?? 0.5,
        importance: input.importance ?? 0.5,
        tags_json: JSON.stringify(input.tags ?? []),
        embedding_json: input.embeddingJson ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.getMemoryObject(input.id)!;
  }

  getMemoryObject(id: string): ResearchMemoryObject | null {
    const row = this.db.prepare('SELECT * FROM research_memory_objects WHERE id = ?').get(id) as ResearchMemoryObjectRow | undefined;
    return row ? rowToMemoryObject(row) : null;
  }

  listMemoryObjectsByProject(projectId: string, opts?: { type?: string; status?: string; limit?: number }): ResearchMemoryObject[] {
    const conditions: string[] = ['project_id = ?'];
    const params: unknown[] = [projectId];
    if (opts?.type) { conditions.push('type = ?'); params.push(opts.type); }
    if (opts?.status) { conditions.push('status = ?'); params.push(opts.status); }
    const limit = opts?.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM research_memory_objects WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as ResearchMemoryObjectRow[];
    return rows.map(rowToMemoryObject);
  }

  searchMemoryObjects(query: string, opts?: { projectId?: string; type?: string; status?: string; limit?: number }): ResearchMemoryObject[] {
    const searchTerm = `%${query}%`;
    const conditions: string[] = ['(content LIKE ? OR summary LIKE ?)'];
    const params: unknown[] = [searchTerm, searchTerm];
    if (opts?.projectId) { conditions.push('project_id = ?'); params.push(opts.projectId); }
    if (opts?.type) { conditions.push('type = ?'); params.push(opts.type); }
    if (opts?.status) { conditions.push('status = ?'); params.push(opts.status); }
    const limit = opts?.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM research_memory_objects WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as ResearchMemoryObjectRow[];
    return rows.map(rowToMemoryObject);
  }

  updateMemoryObject(id: string, patch: {
    content?: string;
    summary?: string | null;
    status?: string;
    type?: string;
    sourceRefs?: string[];
    relationRefs?: string[];
    validFrom?: number | null;
    validTo?: number | null;
    confidence?: number;
    importance?: number;
    tags?: string[];
  }): ResearchMemoryObject | null {
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: Date.now() };

    if (patch.content !== undefined) { fields.push('content = @content'); params.content = patch.content; }
    if (patch.summary !== undefined) { fields.push('summary = @summary'); params.summary = patch.summary; }
    if (patch.status !== undefined) { fields.push('status = @status'); params.status = patch.status; }
    if (patch.type !== undefined) { fields.push('type = @type'); params.type = patch.type; }
    if (patch.sourceRefs !== undefined) { fields.push('source_refs_json = @source_refs_json'); params.source_refs_json = JSON.stringify(patch.sourceRefs); }
    if (patch.relationRefs !== undefined) { fields.push('relation_refs_json = @relation_refs_json'); params.relation_refs_json = JSON.stringify(patch.relationRefs); }
    if (patch.validFrom !== undefined) { fields.push('valid_from = @valid_from'); params.valid_from = patch.validFrom; }
    if (patch.validTo !== undefined) { fields.push('valid_to = @valid_to'); params.valid_to = patch.validTo; }
    if (patch.confidence !== undefined) { fields.push('confidence = @confidence'); params.confidence = patch.confidence; }
    if (patch.importance !== undefined) { fields.push('importance = @importance'); params.importance = patch.importance; }
    if (patch.tags !== undefined) { fields.push('tags_json = @tags_json'); params.tags_json = JSON.stringify(patch.tags); }

    this.db.prepare(`UPDATE research_memory_objects SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.getMemoryObject(id);
  }

  deleteMemoryObject(id: string): boolean {
    const r = this.db.prepare('DELETE FROM research_memory_objects WHERE id = ?').run(id);
    return r.changes > 0;
  }

  updateEmbedding(id: string, embeddingJson: string | null): ResearchMemoryObject | null {
    const now = Date.now();
    this.db.prepare('UPDATE research_memory_objects SET embedding_json = ?, updated_at = ? WHERE id = ?').run(embeddingJson, now, id);
    return this.getMemoryObject(id);
  }

  listWithEmbeddings(opts?: { projectId?: string; limit?: number }): MemoryObjectWithEmbedding[] {
    const conditions: string[] = ['embedding_json IS NOT NULL'];
    const params: unknown[] = [];
    if (opts?.projectId) { conditions.push('project_id = ?'); params.push(opts.projectId); }
    const limit = opts?.limit ?? 500;
    return this.db
      .prepare(`SELECT id, project_id, content, summary, embedding_json FROM research_memory_objects WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as MemoryObjectWithEmbedding[];
  }

  // ─── Hypotheses ─────────────────────────────────────────────────────────────

  createHypothesis(input: {
    id: string;
    projectId: string;
    statement: string;
    status?: string;
    supportingEvidenceIds?: string[];
    contradictingEvidenceIds?: string[];
    relatedSourceIds?: string[];
  }): ResearchHypothesis {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_hypotheses (
          id, project_id, statement, status, supporting_evidence_ids_json,
          contradicting_evidence_ids_json, related_source_ids_json, superseded_by,
          created_at, updated_at
        ) VALUES (
          @id, @project_id, @statement, @status, @supporting_evidence_ids_json,
          @contradicting_evidence_ids_json, @related_source_ids_json, @superseded_by,
          @created_at, @updated_at
        )`,
      )
      .run({
        id: input.id,
        project_id: input.projectId,
        statement: input.statement,
        status: input.status ?? 'proposed',
        supporting_evidence_ids_json: JSON.stringify(input.supportingEvidenceIds ?? []),
        contradicting_evidence_ids_json: JSON.stringify(input.contradictingEvidenceIds ?? []),
        related_source_ids_json: JSON.stringify(input.relatedSourceIds ?? []),
        superseded_by: null,
        created_at: now,
        updated_at: now,
      });
    return this.getHypothesis(input.id)!;
  }

  getHypothesis(id: string): ResearchHypothesis | null {
    const row = this.db.prepare('SELECT * FROM research_hypotheses WHERE id = ?').get(id) as ResearchHypothesisRow | undefined;
    return row ? rowToHypothesis(row) : null;
  }

  listHypothesesByProject(projectId: string): ResearchHypothesis[] {
    const rows = this.db
      .prepare('SELECT * FROM research_hypotheses WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as ResearchHypothesisRow[];
    return rows.map(rowToHypothesis);
  }

  updateHypothesis(id: string, patch: {
    status?: string;
    supersededBy?: string | null;
    supportingEvidenceIds?: string[];
    contradictingEvidenceIds?: string[];
    relatedSourceIds?: string[];
  }): ResearchHypothesis | null {
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: Date.now() };

    if (patch.status !== undefined) { fields.push('status = @status'); params.status = patch.status; }
    if (patch.supersededBy !== undefined) { fields.push('superseded_by = @superseded_by'); params.superseded_by = patch.supersededBy; }
    if (patch.supportingEvidenceIds !== undefined) { fields.push('supporting_evidence_ids_json = @supporting_evidence_ids_json'); params.supporting_evidence_ids_json = JSON.stringify(patch.supportingEvidenceIds); }
    if (patch.contradictingEvidenceIds !== undefined) { fields.push('contradicting_evidence_ids_json = @contradicting_evidence_ids_json'); params.contradicting_evidence_ids_json = JSON.stringify(patch.contradictingEvidenceIds); }
    if (patch.relatedSourceIds !== undefined) { fields.push('related_source_ids_json = @related_source_ids_json'); params.related_source_ids_json = JSON.stringify(patch.relatedSourceIds); }

    this.db.prepare(`UPDATE research_hypotheses SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.getHypothesis(id);
  }

  deleteHypothesis(id: string): boolean {
    const r = this.db.prepare('DELETE FROM research_hypotheses WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Candidates ─────────────────────────────────────────────────────────────

  createCandidate(input: {
    id: string;
    projectId: string;
    proposedType: string;
    content: string;
    rationale: string;
    sourceRefs?: string[];
    confidence?: number;
    createdBySessionId?: string | null;
  }): ResearchMemoryCandidate {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO research_memory_candidates (
          id, project_id, proposed_type, content, rationale, source_refs_json,
          confidence, status, created_by_session_id, created_at
        ) VALUES (
          @id, @project_id, @proposed_type, @content, @rationale, @source_refs_json,
          @confidence, 'pending', @created_by_session_id, @created_at
        )`,
      )
      .run({
        id: input.id,
        project_id: input.projectId,
        proposed_type: input.proposedType,
        content: input.content,
        rationale: input.rationale,
        source_refs_json: JSON.stringify(input.sourceRefs ?? []),
        confidence: input.confidence ?? 0.5,
        created_by_session_id: input.createdBySessionId ?? null,
        created_at: now,
      });
    return this.getCandidate(input.id)!;
  }

  getCandidate(id: string): ResearchMemoryCandidate | null {
    const row = this.db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(id) as ResearchMemoryCandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  listCandidatesByProject(projectId: string, status?: string): ResearchMemoryCandidate[] {
    let rows: ResearchMemoryCandidateRow[];
    if (status) {
      rows = this.db
        .prepare('SELECT * FROM research_memory_candidates WHERE project_id = ? AND status = ? ORDER BY created_at DESC')
        .all(projectId, status) as ResearchMemoryCandidateRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM research_memory_candidates WHERE project_id = ? ORDER BY created_at DESC')
        .all(projectId) as ResearchMemoryCandidateRow[];
    }
    return rows.map(rowToCandidate);
  }

  acceptCandidate(id: string, embeddingJson?: string | null): AcceptCandidateResult {
    const now = Date.now();
    const txn = this.db.transaction((): AcceptCandidateResult => {
      const candidateRow = this.db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(id) as ResearchMemoryCandidateRow | undefined;
      if (!candidateRow) throw new Error('Candidate not found');

      const memoryId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO research_memory_objects (
            id, project_id, type, content, summary, source_refs_json, relation_refs_json,
            valid_from, valid_to, status, confidence, importance, tags_json,
            embedding_json, created_at, updated_at
          ) VALUES (
            @id, @project_id, @type, @content, @summary, @source_refs_json, @relation_refs_json,
            @valid_from, @valid_to, @status, @confidence, @importance, @tags_json,
            @embedding_json, @created_at, @updated_at
          )`,
        )
        .run({
          id: memoryId,
          project_id: candidateRow.project_id,
          type: candidateRow.proposed_type,
          content: candidateRow.content,
          summary: null,
          source_refs_json: candidateRow.source_refs_json,
          relation_refs_json: JSON.stringify([]),
          valid_from: null,
          valid_to: null,
          status: 'active',
          confidence: candidateRow.confidence,
          importance: 0.7,
          tags_json: JSON.stringify(['accepted_candidate']),
          embedding_json: embeddingJson ?? null,
          created_at: now,
          updated_at: now,
        });

      this.db.prepare('UPDATE research_memory_candidates SET status = ?, reviewed_at = ? WHERE id = ?').run('accepted', now, id);

      const acceptedRow = this.db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(id) as ResearchMemoryCandidateRow;
      const memoryRow = this.db.prepare('SELECT * FROM research_memory_objects WHERE id = ?').get(memoryId) as ResearchMemoryObjectRow;
      return { success: true, candidate: rowToCandidate(acceptedRow), memory: rowToMemoryObject(memoryRow) };
    });
    return txn();
  }

  rejectCandidate(id: string): ResearchMemoryCandidate | null {
    const now = Date.now();
    this.db.prepare('UPDATE research_memory_candidates SET status = ?, reviewed_at = ? WHERE id = ?').run('rejected', now, id);
    return this.getCandidate(id);
  }

  deleteCandidate(id: string): boolean {
    const r = this.db.prepare('DELETE FROM research_memory_candidates WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Relations ──────────────────────────────────────────────────────────────

  createRelation(input: { projectId: string; fromMemoryId: string; toMemoryId: string; relationType: string }): ResearchMemoryRelation {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO research_memory_relations (id, project_id, from_memory_id, to_memory_id, relation_type, created_at)
         VALUES (@id, @project_id, @from_memory_id, @to_memory_id, @relation_type, @created_at)`,
      )
      .run({
        id,
        project_id: input.projectId,
        from_memory_id: input.fromMemoryId,
        to_memory_id: input.toMemoryId,
        relation_type: input.relationType,
        created_at: now,
      });
    return this.getRelation(id)!;
  }

  getRelation(id: string): ResearchMemoryRelation | null {
    const row = this.db.prepare('SELECT * FROM research_memory_relations WHERE id = ?').get(id) as ResearchMemoryRelationRow | undefined;
    return row ? rowToRelation(row) : null;
  }

  listRelationsByMemory(memoryId: string): ResearchMemoryRelation[] {
    const rows = this.db
      .prepare('SELECT * FROM research_memory_relations WHERE from_memory_id = ? OR to_memory_id = ? ORDER BY created_at DESC')
      .all(memoryId, memoryId) as ResearchMemoryRelationRow[];
    return rows.map(rowToRelation);
  }

  listRelationsByProject(projectId: string): ResearchMemoryRelation[] {
    const rows = this.db
      .prepare('SELECT * FROM research_memory_relations WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ResearchMemoryRelationRow[];
    return rows.map(rowToRelation);
  }

  deleteRelation(id: string): boolean {
    const r = this.db.prepare('DELETE FROM research_memory_relations WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Import ─────────────────────────────────────────────────────────────────

  createImportBatch(input: {
    id: string;
    source: string;
    sourceProjectPath?: string | null;
    targetProjectPath?: string | null;
  }): ImportBatch {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO import_batches (id, source, source_project_path, target_project_path, status, total_items, applied_items, created_at)
         VALUES (@id, @source, @source_project_path, @target_project_path, 'pending', 0, 0, @created_at)`,
      )
      .run({
        id: input.id,
        source: input.source,
        source_project_path: input.sourceProjectPath ?? null,
        target_project_path: input.targetProjectPath ?? null,
        created_at: now,
      });
    return this.getImportBatch(input.id)!;
  }

  getImportBatch(id: string): ImportBatch | null {
    const row = this.db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id) as ImportBatchRow | undefined;
    return row ? rowToImportBatch(row) : null;
  }

  updateImportBatch(id: string, patch: {
    status?: string;
    totalItems?: number;
    appliedItems?: number;
    rolledBackAt?: number | null;
  }): ImportBatch | null {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.status !== undefined) { fields.push('status = @status'); params.status = patch.status; }
    if (patch.totalItems !== undefined) { fields.push('total_items = @total_items'); params.total_items = patch.totalItems; }
    if (patch.appliedItems !== undefined) { fields.push('applied_items = @applied_items'); params.applied_items = patch.appliedItems; }
    if (patch.rolledBackAt !== undefined) { fields.push('rolled_back_at = @rolled_back_at'); params.rolled_back_at = patch.rolledBackAt; }
    if (fields.length === 0) return this.getImportBatch(id);
    this.db.prepare(`UPDATE import_batches SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.getImportBatch(id);
  }

  listImportBatches(): ImportBatch[] {
    const rows = this.db.prepare('SELECT * FROM import_batches ORDER BY created_at DESC').all() as ImportBatchRow[];
    return rows.map(rowToImportBatch);
  }

  createImportItem(input: {
    id: string;
    batchId: string;
    sourceType: string;
    sourcePath: string;
    sourceHash?: string | null;
    targetType: string;
    targetPath: string;
    title: string;
    summary?: string | null;
    riskLevel?: string;
    requiresAuth?: boolean;
    isEnabled?: boolean;
  }): ImportItem {
    this.db
      .prepare(
        `INSERT INTO import_items (
          id, batch_id, source_type, source_path, source_hash, target_type, target_path,
          title, summary, risk_level, requires_auth, is_enabled, status, created_at
        ) VALUES (
          @id, @batch_id, @source_type, @source_path, @source_hash, @target_type, @target_path,
          @title, @summary, @risk_level, @requires_auth, @is_enabled, 'imported', @created_at
        )`,
      )
      .run({
        id: input.id,
        batch_id: input.batchId,
        source_type: input.sourceType,
        source_path: input.sourcePath,
        source_hash: input.sourceHash ?? null,
        target_type: input.targetType,
        target_path: input.targetPath,
        title: input.title,
        summary: input.summary ?? null,
        risk_level: input.riskLevel ?? 'safe',
        requires_auth: input.requiresAuth ? 1 : 0,
        is_enabled: input.isEnabled !== false ? 1 : 0,
        created_at: Date.now(),
      });
    return this.getImportItem(input.id)!;
  }

  getImportItem(id: string): ImportItem | null {
    const row = this.db.prepare('SELECT * FROM import_items WHERE id = ?').get(id) as ImportItemRow | undefined;
    return row ? rowToImportItem(row) : null;
  }

  getImportItemsByBatch(batchId: string): ImportItem[] {
    const rows = this.db.prepare('SELECT * FROM import_items WHERE batch_id = ? ORDER BY created_at ASC').all(batchId) as ImportItemRow[];
    return rows.map(rowToImportItem);
  }

  updateImportItem(id: string, patch: {
    status?: string;
    riskLevel?: string;
    isEnabled?: boolean;
  }): ImportItem | null {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.status !== undefined) { fields.push('status = @status'); params.status = patch.status; }
    if (patch.riskLevel !== undefined) { fields.push('risk_level = @risk_level'); params.risk_level = patch.riskLevel; }
    if (patch.isEnabled !== undefined) { fields.push('is_enabled = @is_enabled'); params.is_enabled = patch.isEnabled ? 1 : 0; }
    if (fields.length === 0) return this.getImportItem(id);
    this.db.prepare(`UPDATE import_items SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.getImportItem(id);
  }

  deleteImportItemsByBatch(batchId: string): void {
    this.db.prepare('DELETE FROM import_items WHERE batch_id = ?').run(batchId);
  }
}

// ─── Row Converters ───────────────────────────────────────────────────────────

function rowToSession(row: ResearchSessionRow): ResearchSession {
  return {
    id: row.id,
    sessionId: row.session_id,
    originalQuery: row.original_query,
    clarification: row.clarification,
    contextJson: row.context_json,
    status: row.status,
    currentPhase: row.current_phase,
    iterations: row.iterations,
    coverage: row.coverage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    runStatus: row.run_status,
    planVersion: row.plan_version,
    activeStepId: row.active_step_id,
    progressSummary: row.progress_summary,
    completedAt: row.completed_at,
    errorJson: row.error_json,
  };
}

function rowToPlanStep(row: ResearchPlanStepRow): ResearchPlanStep {
  return {
    id: row.id,
    runId: row.run_id,
    orderNum: row.order_num,
    userFacingLabel: row.user_facing_label,
    internalQuestionIds: safeParseStringArray(row.internal_question_ids),
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function rowToActivity(row: ResearchActivityRow): ResearchActivity {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    visibility: row.visibility,
    createdAt: row.created_at,
  };
}

function rowToEvent(row: ResearchEventRow): ResearchEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    visibility: row.visibility,
    createdAt: row.created_at,
  };
}

function rowToSource(row: ResearchSourceRow): ResearchSource {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    url: row.url,
    canonicalUrl: row.canonical_url,
    sourceType: row.source_type,
    allowedByPolicy: row.allowed_by_policy === 1,
    reliabilityJson: row.reliability_json,
    dedupeKey: row.dedupe_key,
    rejectedReason: row.rejected_reason,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReport(row: ResearchReportRow): ResearchReport {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    markdown: row.markdown,
    outlineJson: row.outline_json,
    sourceIdsJson: row.source_ids_json,
    citationIdsJson: row.citation_ids_json,
    activitySummaryJson: row.activity_summary_json,
    exportMetadataJson: row.export_metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCitation(row: ResearchCitationRow): ResearchCitation {
  return {
    id: row.id,
    runId: row.run_id,
    reportId: row.report_id,
    sourceId: row.source_id,
    findingId: row.finding_id,
    claim: row.claim,
    locatorJson: row.locator_json,
    quotedEvidence: row.quoted_evidence,
    createdAt: row.created_at,
  };
}

function rowToProject(row: ResearchProjectRow): ResearchProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProjectState(row: ResearchProjectStateRow): ResearchProjectState {
  return {
    projectId: row.project_id,
    stateJson: row.state_json,
    updatedAt: row.updated_at,
  };
}

function rowToMemoryObject(row: ResearchMemoryObjectRow): ResearchMemoryObject {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    content: row.content,
    summary: row.summary,
    sourceRefsJson: row.source_refs_json,
    relationRefsJson: row.relation_refs_json,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    confidence: row.confidence,
    importance: row.importance,
    tagsJson: row.tags_json,
    embeddingJson: row.embedding_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToHypothesis(row: ResearchHypothesisRow): ResearchHypothesis {
  return {
    id: row.id,
    projectId: row.project_id,
    statement: row.statement,
    status: row.status,
    supportingEvidenceIdsJson: row.supporting_evidence_ids_json,
    contradictingEvidenceIdsJson: row.contradicting_evidence_ids_json,
    relatedSourceIdsJson: row.related_source_ids_json,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCandidate(row: ResearchMemoryCandidateRow): ResearchMemoryCandidate {
  return {
    id: row.id,
    projectId: row.project_id,
    proposedType: row.proposed_type,
    content: row.content,
    rationale: row.rationale,
    sourceRefsJson: row.source_refs_json,
    confidence: row.confidence,
    status: row.status,
    createdBySessionId: row.created_by_session_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function rowToRelation(row: ResearchMemoryRelationRow): ResearchMemoryRelation {
  return {
    id: row.id,
    projectId: row.project_id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    relationType: row.relation_type,
    createdAt: row.created_at,
  };
}

function rowToImportBatch(row: ImportBatchRow): ImportBatch {
  return {
    id: row.id,
    source: row.source,
    sourceProjectPath: row.source_project_path,
    targetProjectPath: row.target_project_path,
    status: row.status,
    totalItems: row.total_items,
    appliedItems: row.applied_items,
    createdAt: row.created_at,
    rolledBackAt: row.rolled_back_at,
  };
}

function rowToImportItem(row: ImportItemRow): ImportItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceType: row.source_type,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    targetType: row.target_type,
    targetPath: row.target_path,
    title: row.title,
    summary: row.summary,
    riskLevel: row.risk_level,
    requiresAuth: row.requires_auth === 1,
    isEnabled: row.is_enabled === 1,
    status: row.status,
    createdAt: row.created_at,
  };
}

function safeParseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}