import type { JournalRecord } from '@duya/agent-protocol';
import type {
  WorkflowRunApiV1,
  WorkflowRunCreateInput,
  WorkflowRunFilter,
  WorkflowRunOutcomeInput,
  WorkflowRunSnapshotSaveInput,
  WorkflowRunStatus,
} from '@duya/agent-protocol/workflow-runs';
import type { CoreDataHostStores } from '@duya/data/core-data-host';

/** Host-owned async boundary over the durable workflow-run Data store. */
export function createHostWorkflowRunApi(
  stores: Pick<CoreDataHostStores, 'workflowRuns'>,
): WorkflowRunApiV1 {
  const runs = stores.workflowRuns;
  return {
    async createRun(input: WorkflowRunCreateInput) {
      return runs.createRun(input);
    },
    async getRun(id) {
      return runs.getRun(id);
    },
    async getRunByDedupKey(dedupKey) {
      return runs.getRunByDedupKey(dedupKey);
    },
    async listRuns(filter?: WorkflowRunFilter) {
      return runs.listRuns(filter);
    },
    async listActiveRunIds() {
      return runs.listActiveRunIds();
    },
    async updateStatus(id: string, status: WorkflowRunStatus, pauseMessage?: string | null) {
      return runs.updateStatus(id, status, pauseMessage);
    },
    async finishRun(id, outcome: WorkflowRunOutcomeInput) {
      return runs.finishRun(id, outcome);
    },
    async setWaitTill(id, waitTill) {
      return runs.setWaitTill(id, waitTill);
    },
    async setVersionId(id, versionId) {
      return runs.setVersionId(id, versionId);
    },
    async listWaitingPast(nowMs) {
      return runs.listWaitingPast(nowMs);
    },
    async reconcileStaleRuns(activeRunIds) {
      return runs.reconcileStaleRuns(new Set(activeRunIds));
    },
    async saveSnapshot(snapshot: WorkflowRunSnapshotSaveInput) {
      runs.saveSnapshot(snapshot);
      return true;
    },
    async loadSnapshot(runId) {
      return runs.loadSnapshot(runId);
    },
    async appendJournalRecord(runId, record: JournalRecord) {
      runs.appendJournalRecord(runId, record);
      return true;
    },
    async listEvents(runId, afterSeq = -1) {
      return runs.listEvents(runId, afterSeq);
    },
    async latestEventSeq(runId) {
      return runs.latestEventSeq(runId);
    },
    async getEventCount(runId) {
      return runs.getEventCount(runId);
    },
    async loadJournal(runId) {
      return runs.loadJournal(runId);
    },
    async deleteRun(id) {
      return runs.deleteRun(id);
    },
  };
}
