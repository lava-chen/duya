/**
 * Research run DB adapter factory.
 *
 * Extracted from the inline block that previously lived inside
 * `streamChat`'s research-mode dispatch (Plan 211, Phase A).
 *
 * The factory produces three things the orchestrator needs to run a
 * research mode pass and persist its artifacts:
 *
 *  - `_researchRunId`  — the id of the (created or reused) research
 *                        session row bound to the chat session
 *  - `runDB`           — the typed action surface the orchestrator
 *                        uses to write plan steps / activities /
 *                        events / sources / citations / reports
 *  - `persistState`    — the closure the orchestrator calls to
 *                        snapshot its in-memory research state to
 *                        the session row
 *
 * Pure extraction — no behavior change vs the inline block.
 */

import {
  createResearchActivity,
  createResearchCitation,
  createResearchEvent,
  createResearchPlanSteps,
  createResearchSession,
  getResearchEventMaxSequence,
  getResearchSessionBySessionId,
  updateResearchPlanStep,
  updateResearchSession,
  upsertResearchReport,
  upsertResearchSource,
} from './db.js';
import type { ModeContext } from '../modes/types.js';
import { logger } from '../utils/logger.js';

/**
 * Subset of the plan-step `status` enum accepted by the DB layer.
 * `updateResearchPlanStep` only writes a whitelisted set of values;
 * any other string is silently dropped.
 */
const PLAN_STEP_STATUSES = [
  'pending',
  'active',
  'completed',
  'skipped',
  'failed',
] as const;

const PLAN_STEP_STATUS_SET: ReadonlySet<string> = new Set(PLAN_STEP_STATUSES);

type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

function asPlanStepStatus(status: unknown): PlanStepStatus | undefined {
  return typeof status === 'string' && PLAN_STEP_STATUS_SET.has(status)
    ? (status as PlanStepStatus)
    : undefined;
}

function asVisibility(
  v: unknown,
): 'user' | 'debug' | undefined {
  return v === 'user' || v === 'debug' ? v : undefined;
}

export interface ResearchRunDB {
  _researchRunId: string;
  runDB: NonNullable<ModeContext['runDB']>;
  persistState: NonNullable<ModeContext['persistState']>;
}

/**
 * Build a research-run DB adapter bound to a chat session.
 *
 * Resolves (or creates) the `ResearchSessionRow` for the chat session,
 * then returns the run id and the orchestrator-facing action set.
 *
 * The original inline block in `streamChat` ran this resolution
 * synchronously-after-await so that `_researchRunId` was populated
 * before the orchestrator started. We preserve that contract by
 * making the factory `async` and `await`ing it at the call site.
 */
export async function buildResearchRunDB(
  sessionId: string | undefined,
  queryText: string,
): Promise<ResearchRunDB> {
  let researchRunId = '';

  // NOTE: getResearchSessionBySessionId is documented as synchronous, but in
  // IPC mode it goes through sendDbRequest which returns a Promise. The
  // historical code cast that Promise to a row via `as unknown as`, causing
  // `!row` to be always false and skipping the create path on first run. We
  // now await to get the real value and unify both modes (direct
  // better-sqlite3 and IPC) behind the same async contract. See Plan 103.
  if (sessionId) {
    const row = await getResearchSessionBySessionId(sessionId);
    if (!row) {
      const id = crypto.randomUUID();
      const created = await createResearchSession({
        id,
        session_id: sessionId,
        original_query: queryText,
        context_json: '{}',
        status: 'active',
        run_status: 'classifying',
      });
      // Defensive: if IPC returned a row with a different id (the
      // dispatcher may re-key), prefer what createResearchSession
      // actually persisted.
      researchRunId = (created as { id?: string } | null)?.id ?? id;
    } else {
      researchRunId = row.id;
      await updateResearchSession(row.id, {
        run_status: 'classifying',
      });
    }
  }

  return {
    _researchRunId: researchRunId,

    runDB: {
      updateRun: async (runId, data) => {
        if (!runId) return;
        await updateResearchSession(
          runId,
          data as Parameters<typeof updateResearchSession>[1],
        );
      },

      createPlanSteps: async (runId, steps) => {
        if (!runId || steps.length === 0) return;
        await createResearchPlanSteps(
          runId,
          steps as Array<{
            id: string;
            order_num: number;
            user_facing_label: string;
            internal_question_ids: string[];
          }>,
        );
      },

      updatePlanStep: async (stepId, data) => {
        if (!stepId) return;
        await updateResearchPlanStep(stepId, {
          status: asPlanStepStatus(data.status),
          started_at: data.started_at as number | null | undefined,
          completed_at: data.completed_at as number | null | undefined,
        });
      },

      logActivity: async (data) => {
        const runId = data.run_id as string;
        if (!runId) return;
        await createResearchActivity({
          id: crypto.randomUUID(),
          run_id: runId,
          sequence: (data.sequence as number) || 0,
          kind: (data.kind as string) || 'info',
          title: (data.title as string) || '',
          detail: data.detail as string | undefined,
          visibility: asVisibility(data.visibility) ?? 'user',
        });
      },

      getEventMaxSequence: async (runId) => {
        if (!runId) return 0;
        return await getResearchEventMaxSequence(runId);
      },

      logEvent: async (data) => {
        const runId = data.run_id as string;
        if (!runId) return;
        await createResearchEvent({
          id: crypto.randomUUID(),
          run_id: runId,
          sequence: (data.sequence as number) || 0,
          event_type: (data.event_type as string) || 'unknown',
          payload_json: (data.payload_json as string) || '{}',
          visibility: asVisibility(data.visibility) ?? 'user',
        });
      },

      upsertSource: async (data) => {
        const runId = data.run_id as string;
        const id = data.id as string;
        if (!runId || !id) return;
        await upsertResearchSource({
          id,
          run_id: runId,
          title: (data.title as string) || 'Untitled source',
          url: data.url as string | null | undefined,
          canonical_url: data.canonical_url as string | null | undefined,
          source_type: (data.source_type as string) || 'web',
          allowed_by_policy: data.allowed_by_policy as boolean | undefined,
          reliability_json: data.reliability_json as string | null | undefined,
          dedupe_key: data.dedupe_key as string | null | undefined,
          rejected_reason: data.rejected_reason as string | null | undefined,
          metadata_json: data.metadata_json as string | null | undefined,
        });
      },

      createCitation: async (data) => {
        const runId = data.run_id as string;
        const id = data.id as string;
        const sourceId = data.source_id as string;
        if (!runId || !id || !sourceId) return;
        await createResearchCitation({
          id,
          run_id: runId,
          report_id: data.report_id as string | null | undefined,
          source_id: sourceId,
          finding_id: data.finding_id as string | null | undefined,
          claim: (data.claim as string) || '',
          locator_json: data.locator_json as string | null | undefined,
          quoted_evidence: data.quoted_evidence as string | null | undefined,
        });
      },

      upsertReport: async (data) => {
        const runId = data.run_id as string;
        const id = data.id as string;
        const markdown = data.markdown as string;
        if (!runId || !id || !markdown) return;
        await upsertResearchReport({
          id,
          run_id: runId,
          title: data.title as string | null | undefined,
          markdown,
          outline_json: data.outline_json as string | null | undefined,
          source_ids_json: data.source_ids_json as string | undefined,
          citation_ids_json: data.citation_ids_json as string | undefined,
          activity_summary_json: data.activity_summary_json as string | null | undefined,
          export_metadata_json: data.export_metadata_json as string | null | undefined,
        });
      },
    },

    persistState: async (data) => {
      const context = data.context as string;
      if (!context) return;

      // Get or create research session for this chat session
      let researchId: string;
      if (sessionId) {
        const row = await getResearchSessionBySessionId(sessionId);
        if (!row) {
          const id = crypto.randomUUID();
          await createResearchSession({
            id,
            session_id: sessionId,
            original_query: queryText,
            context_json: context,
            status: 'active',
          });
          researchId = id;
        } else {
          researchId = row.id;
          await updateResearchSession(row.id, {
            context_json: context,
            status: 'active',
            current_phase: (data.current_phase as string) || 'researching',
            iterations: (data.iterations as number) || row.iterations,
            coverage: (data.coverage as number) || row.coverage,
          });
        }
        // Keep the captured researchRunId in sync with the row we
        // just touched so callers that read _researchRunId after
        // persistState see the canonical id.
        researchRunId = researchId;
      } else {
        logger.warn(
          '[researchRunDb] persistState called without a sessionId; skipping persistence',
        );
      }
    },
  };
}
