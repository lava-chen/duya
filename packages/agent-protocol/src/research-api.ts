/**
 * Research persistence actions used by the legacy Agent DB bridge while the
 * Agent package is being retired. This is a bounded domain API, not a generic
 * SQL or arbitrary database request surface.
 */
export const HOST_RESEARCH_ACTIONS = [
  'researchSession:create',
  'researchSession:get',
  'researchSession:getBySessionId',
  'researchSession:update',
  'researchSession:delete',
  'researchSession:list',
  'researchSession:listByStatus',
  'researchSession:getActiveRun',
  'researchSession:listActiveRuns',
  'researchPlanStep:createSteps',
  'researchPlanStep:getByRunId',
  'researchPlanStep:update',
  'researchPlanStep:deleteByRunId',
  'researchActivity:create',
  'researchActivity:getByRunId',
  'researchActivity:getMaxSequence',
  'researchActivity:deleteByRunId',
  'researchEvent:create',
  'researchEvent:getByRunId',
  'researchEvent:getMaxSequence',
  'researchSource:upsert',
  'researchSource:getByRunId',
  'researchCitation:create',
  'researchCitation:getByRunId',
  'researchReport:upsert',
  'researchReport:getLatest',
  'researchMemory:project:create',
  'researchMemory:project:get',
  'researchMemory:project:list',
  'researchMemory:project:update',
  'researchMemory:project:delete',
  'researchMemory:projectState:get',
  'researchMemory:projectState:upsert',
  'researchMemory:object:create',
  'researchMemory:object:get',
  'researchMemory:object:listByProject',
  'researchMemory:object:search',
  'researchMemory:object:update',
  'researchMemory:object:delete',
  'researchMemory:hypothesis:create',
  'researchMemory:hypothesis:get',
  'researchMemory:hypothesis:listByProject',
  'researchMemory:hypothesis:update',
  'researchMemory:hypothesis:delete',
  'researchMemory:candidate:create',
  'researchMemory:candidate:get',
  'researchMemory:candidate:listByProject',
  'researchMemory:candidate:accept',
  'researchMemory:candidate:reject',
  'researchMemory:candidate:delete',
  'researchMemory:object:updateEmbedding',
  'researchMemory:object:listWithEmbeddings',
  'researchMemory:relation:create',
  'researchMemory:relation:listByMemory',
  'researchMemory:relation:listByProject',
  'researchMemory:relation:delete',
] as const;

export type HostResearchAction = (typeof HOST_RESEARCH_ACTIONS)[number];

export interface HostResearchApiV1 {
  dispatch(
    action: HostResearchAction,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export function isHostResearchAction(value: unknown): value is HostResearchAction {
  return typeof value === 'string' && HOST_RESEARCH_ACTIONS.some((action) => action === value);
}
