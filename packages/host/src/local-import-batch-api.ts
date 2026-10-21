import type { HostLocalImportBatchApiV1 } from '@duya/agent-protocol/import-batches';
import type { ImportBatchStore } from '@duya/data/import-batch-store';

/** Local authenticated projection over Host-owned import metadata. */
export function createHostLocalImportBatchApi(store: ImportBatchStore): HostLocalImportBatchApiV1 {
  return {
    async createBatch(input) {
      return store.create(input);
    },
    async addItem(input) {
      return store.addItem(input);
    },
    async updateBatchStatus(batchId, status, appliedItems) {
      store.updateStatus(batchId, status, appliedItems);
    },
    async rollbackBatchItems(batchId) {
      store.rollbackItems(batchId);
    },
    async getBatchItems(batchId) {
      return store.getItems(batchId);
    },
    async listBatches() {
      return store.list();
    },
  };
}
