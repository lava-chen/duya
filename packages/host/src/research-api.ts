import type { HostResearchAction, HostResearchApiV1 } from '@duya/agent-protocol/research-api';
import type { CoreDataHostStores } from '@duya/data/core-data-host';

/** Host-owned Research persistence API used by Desktop's legacy Agent bridge. */
export function createHostResearchApi(
  stores: Pick<CoreDataHostStores, 'research'>,
): HostResearchApiV1 {
  const research = stores.research;

  return {
    async dispatch(action, payload) {
      const p = payload as Record<string, unknown>;
      switch (action) {
        case 'researchSession:create':
          return research.createSession({
            id: p.id as string,
            sessionId: p.session_id as string,
            originalQuery: p.original_query as string,
            clarification: p.clarification as string | null,
            contextJson: p.context_json as string,
            status: p.status as string,
            title: p.title as string | null,
            runStatus: p.run_status as string | null,
          });
        case 'researchSession:get':
          return research.getSession(p.id as string);
        case 'researchSession:getBySessionId':
          return research.getSessionBySessionId(p.sessionId as string);
        case 'researchSession:update': {
          const patch: Parameters<typeof research.updateSession>[1] = {};
          if (p.clarification !== undefined) patch.clarification = p.clarification as string | null;
          if (p.context_json !== undefined) patch.contextJson = p.context_json as string;
          if (p.status !== undefined) patch.status = p.status as string;
          if (p.current_phase !== undefined) patch.currentPhase = p.current_phase as string;
          if (p.iterations !== undefined) patch.iterations = p.iterations as number;
          if (p.coverage !== undefined) patch.coverage = p.coverage as number;
          if (p.title !== undefined) patch.title = p.title as string | null;
          if (p.run_status !== undefined) patch.runStatus = p.run_status as string | null;
          if (p.plan_version !== undefined) patch.planVersion = p.plan_version as number;
          if (p.active_step_id !== undefined) patch.activeStepId = p.active_step_id as string | null;
          if (p.progress_summary !== undefined) patch.progressSummary = p.progress_summary as string | null;
          if (p.completed_at !== undefined) patch.completedAt = p.completed_at as number | null;
          if (p.error_json !== undefined) patch.errorJson = p.error_json as string | null;
          return research.updateSession(p.id as string, patch);
        }
        case 'researchSession:delete':
          return { success: research.deleteSession(p.id as string) };
        case 'researchSession:list':
          return research.listSessions(p.limit as number);
        case 'researchSession:listByStatus':
          return research.listSessionsByStatus(p.status as string);
        case 'researchSession:getActiveRun':
          return research.getActiveRun(p.sessionId as string);
        case 'researchSession:listActiveRuns':
          return research.listActiveRuns();
        case 'researchPlanStep:createSteps': {
          const steps = p.steps as Array<{
            id: string;
            order_num: number;
            user_facing_label: string;
            internal_question_ids: string[];
          }>;
          return research.createSteps(p.runId as string, steps.map((step) => ({
            id: step.id,
            orderNum: step.order_num,
            userFacingLabel: step.user_facing_label,
            internalQuestionIds: step.internal_question_ids,
          })));
        }
        case 'researchPlanStep:getByRunId':
          return research.getPlanStepsByRunId(p.runId as string);
        case 'researchPlanStep:update': {
          const patch: Parameters<typeof research.updatePlanStep>[1] = {};
          if (p.status !== undefined) patch.status = p.status as string;
          if (p.started_at !== undefined) patch.startedAt = p.started_at as number | null;
          if (p.completed_at !== undefined) patch.completedAt = p.completed_at as number | null;
          return research.updatePlanStep(p.stepId as string, patch);
        }
        case 'researchPlanStep:deleteByRunId':
          research.deletePlanStepsByRunId(p.runId as string);
          return undefined;
        case 'researchActivity:create':
          return research.createActivity({
            id: p.id as string,
            runId: p.run_id as string,
            sequence: p.sequence as number,
            kind: p.kind as string,
            title: p.title as string,
            detail: p.detail as string | null,
            visibility: p.visibility as string,
          });
        case 'researchActivity:getByRunId':
          return research.getActivitiesByRunId(p.runId as string, {
            ...(p.visibility === undefined ? {} : { visibility: p.visibility as string }),
            ...(p.limit === undefined ? {} : { limit: p.limit as number }),
            ...(p.afterSequence === undefined ? {} : { afterSequence: p.afterSequence as number }),
          });
        case 'researchActivity:getMaxSequence':
          return { max_seq: research.getMaxActivitySequence(p.runId as string) };
        case 'researchActivity:deleteByRunId':
          research.deleteActivitiesByRunId(p.runId as string);
          return undefined;
        case 'researchEvent:create':
          return research.createEvent({
            id: p.id as string,
            runId: p.run_id as string,
            sequence: p.sequence as number,
            eventType: p.event_type as string,
            payloadJson: p.payload_json as string,
            visibility: p.visibility as string,
          });
        case 'researchEvent:getByRunId':
          return research.getEventsByRunId(p.runId as string, {
            ...(p.limit === undefined ? {} : { limit: p.limit as number }),
            ...(p.afterSequence === undefined ? {} : { afterSequence: p.afterSequence as number }),
            ...(p.visibility === undefined ? {} : { visibility: p.visibility as string }),
          });
        case 'researchEvent:getMaxSequence':
          return { max_seq: research.getMaxEventSequence(p.runId as string) };
        case 'researchSource:upsert':
          return research.upsertSource({
            id: p.id as string,
            runId: p.run_id as string,
            title: p.title as string,
            url: p.url as string | null,
            canonicalUrl: (p.canonical_url ?? p.url) as string | null,
            sourceType: p.source_type as string,
            allowedByPolicy: p.allowed_by_policy !== false,
            reliabilityJson: p.reliability_json as string | null,
            dedupeKey: p.dedupe_key as string | null,
            rejectedReason: p.rejected_reason as string | null,
            metadataJson: p.metadata_json as string | null,
          });
        case 'researchSource:getByRunId':
          return research.getSourcesByRunId(p.runId as string);
        case 'researchCitation:create':
          return research.createCitation({
            id: p.id as string,
            runId: p.run_id as string,
            reportId: p.report_id as string | null,
            sourceId: p.source_id as string,
            findingId: p.finding_id as string | null,
            claim: p.claim as string,
            locatorJson: p.locator_json as string | null,
            quotedEvidence: p.quoted_evidence as string | null,
          });
        case 'researchCitation:getByRunId':
          return research.getCitationsByRunId(p.runId as string, p.reportId as string | undefined);
        case 'researchReport:upsert':
          return research.upsertReport({
            id: p.id as string,
            runId: p.run_id as string,
            title: p.title as string | null,
            markdown: p.markdown as string,
            outlineJson: p.outline_json as string | null,
            sourceIdsJson: p.source_ids_json as string,
            citationIdsJson: p.citation_ids_json as string,
            activitySummaryJson: p.activity_summary_json as string | null,
            exportMetadataJson: p.export_metadata_json as string | null,
          });
        case 'researchReport:getLatest':
          return research.getLatestReport(p.runId as string);
        case 'researchMemory:project:create':
          return research.createProject({
            id: p.id as string,
            name: p.name as string,
            description: p.description as string | null,
          });
        case 'researchMemory:project:get':
          return research.getProject(p.id as string);
        case 'researchMemory:project:list':
          return research.listProjects();
        case 'researchMemory:project:update': {
          const patch: Parameters<typeof research.updateProject>[1] = {};
          if (p.name !== undefined) patch.name = p.name as string;
          if (p.description !== undefined) patch.description = p.description as string | null;
          if (p.status !== undefined) patch.status = p.status as string;
          return research.updateProject(p.id as string, patch);
        }
        case 'researchMemory:project:delete':
          return { success: research.deleteProject(p.id as string) };
        case 'researchMemory:projectState:get':
          return research.getProjectState(p.projectId as string);
        case 'researchMemory:projectState:upsert':
          return research.upsertProjectState(
            p.projectId as string,
            typeof p.state === 'string' ? p.state : JSON.stringify(p.state),
          );
        case 'researchMemory:object:create':
          return research.createMemoryObject({
            id: p.id as string,
            projectId: p.projectId as string,
            type: p.type as string,
            content: p.content as string,
            ...(p.summary === undefined ? {} : { summary: p.summary as string | null }),
            ...(p.sourceRefs === undefined ? {} : { sourceRefs: p.sourceRefs as string[] }),
            ...(p.relationRefs === undefined ? {} : { relationRefs: p.relationRefs as string[] }),
            ...(p.validFrom === undefined ? {} : { validFrom: p.validFrom as number | null }),
            ...(p.validTo === undefined ? {} : { validTo: p.validTo as number | null }),
            ...(p.status === undefined ? {} : { status: p.status as string }),
            ...(p.confidence === undefined ? {} : { confidence: p.confidence as number }),
            ...(p.importance === undefined ? {} : { importance: p.importance as number }),
            ...(p.tags === undefined ? {} : { tags: p.tags as string[] }),
            ...(p.embedding_json === undefined ? {} : { embeddingJson: p.embedding_json as string | null }),
          });
        case 'researchMemory:object:get':
          return research.getMemoryObject(p.id as string);
        case 'researchMemory:object:listByProject':
          return research.listMemoryObjectsByProject(p.projectId as string, {
            ...(p.type === undefined ? {} : { type: p.type as string }),
            ...(p.status === undefined ? {} : { status: p.status as string }),
            ...(p.limit === undefined ? {} : { limit: p.limit as number }),
          });
        case 'researchMemory:object:search':
          return research.searchMemoryObjects(p.query as string, {
            ...(p.projectId === undefined ? {} : { projectId: p.projectId as string }),
            ...(p.type === undefined ? {} : { type: p.type as string }),
            ...(p.status === undefined ? {} : { status: p.status as string }),
            ...(p.limit === undefined ? {} : { limit: p.limit as number }),
          });
        case 'researchMemory:object:update': {
          const patch: Parameters<typeof research.updateMemoryObject>[1] = {};
          if (p.content !== undefined) patch.content = p.content as string;
          if (p.summary !== undefined) patch.summary = p.summary as string | null;
          if (p.status !== undefined) patch.status = p.status as string;
          if (p.type !== undefined) patch.type = p.type as string;
          if (p.sourceRefs !== undefined) patch.sourceRefs = p.sourceRefs as string[];
          if (p.relationRefs !== undefined) patch.relationRefs = p.relationRefs as string[];
          if (p.validFrom !== undefined) patch.validFrom = p.validFrom as number | null;
          if (p.validTo !== undefined) patch.validTo = p.validTo as number | null;
          if (p.confidence !== undefined) patch.confidence = p.confidence as number;
          if (p.importance !== undefined) patch.importance = p.importance as number;
          if (p.tags !== undefined) patch.tags = p.tags as string[];
          return research.updateMemoryObject(p.id as string, patch);
        }
        case 'researchMemory:object:delete':
          return { success: research.deleteMemoryObject(p.id as string) };
        case 'researchMemory:hypothesis:create':
          return research.createHypothesis({
            id: p.id as string,
            projectId: p.projectId as string,
            statement: p.statement as string,
            ...(p.status === undefined ? {} : { status: p.status as string }),
            ...(p.supportingEvidenceIds === undefined ? {} : { supportingEvidenceIds: p.supportingEvidenceIds as string[] }),
            ...(p.contradictingEvidenceIds === undefined ? {} : { contradictingEvidenceIds: p.contradictingEvidenceIds as string[] }),
            ...(p.relatedSourceIds === undefined ? {} : { relatedSourceIds: p.relatedSourceIds as string[] }),
          });
        case 'researchMemory:hypothesis:get':
          return research.getHypothesis(p.id as string);
        case 'researchMemory:hypothesis:listByProject':
          return research.listHypothesesByProject(p.projectId as string);
        case 'researchMemory:hypothesis:update': {
          const patch: Parameters<typeof research.updateHypothesis>[1] = {};
          if (p.status !== undefined) patch.status = p.status as string;
          if (p.supersededBy !== undefined) patch.supersededBy = p.supersededBy as string | null;
          if (p.supportingEvidenceIds !== undefined) patch.supportingEvidenceIds = p.supportingEvidenceIds as string[];
          if (p.contradictingEvidenceIds !== undefined) patch.contradictingEvidenceIds = p.contradictingEvidenceIds as string[];
          if (p.relatedSourceIds !== undefined) patch.relatedSourceIds = p.relatedSourceIds as string[];
          return research.updateHypothesis(p.id as string, patch);
        }
        case 'researchMemory:hypothesis:delete':
          return { success: research.deleteHypothesis(p.id as string) };
        case 'researchMemory:candidate:create':
          return research.createCandidate({
            id: p.id as string,
            projectId: p.projectId as string,
            proposedType: p.proposedType as string,
            content: p.content as string,
            rationale: p.rationale as string,
            ...(p.sourceRefs === undefined ? {} : { sourceRefs: p.sourceRefs as string[] }),
            ...(p.confidence === undefined ? {} : { confidence: p.confidence as number }),
            ...(p.createdBySessionId === undefined ? {} : { createdBySessionId: p.createdBySessionId as string | null }),
          });
        case 'researchMemory:candidate:get':
          return research.getCandidate(p.id as string);
        case 'researchMemory:candidate:listByProject':
          return research.listCandidatesByProject(p.projectId as string, p.status as string | undefined);
        case 'researchMemory:candidate:accept':
          return research.acceptCandidate(p.id as string, p.embedding_json as string | null);
        case 'researchMemory:candidate:reject':
          return research.rejectCandidate(p.id as string);
        case 'researchMemory:candidate:delete':
          return { success: research.deleteCandidate(p.id as string) };
        case 'researchMemory:object:updateEmbedding':
          return research.updateEmbedding(p.id as string, p.embedding_json as string | null);
        case 'researchMemory:object:listWithEmbeddings':
          return research.listWithEmbeddings({
            ...(p.projectId === undefined ? {} : { projectId: p.projectId as string }),
            ...(p.limit === undefined ? {} : { limit: p.limit as number }),
          });
        case 'researchMemory:relation:create':
          return research.createRelation({
            projectId: p.projectId as string,
            fromMemoryId: p.fromMemoryId as string,
            toMemoryId: p.toMemoryId as string,
            relationType: p.relationType as string,
          });
        case 'researchMemory:relation:listByMemory':
          return research.listRelationsByMemory(p.memoryId as string);
        case 'researchMemory:relation:listByProject':
          return research.listRelationsByProject(p.projectId as string);
        case 'researchMemory:relation:delete':
          return { success: research.deleteRelation(p.id as string) };
      }
    },
  };
}
