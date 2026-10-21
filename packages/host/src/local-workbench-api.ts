import type { HostLocalWorkbenchApiV1 } from '@duya/agent-protocol/workbench';
import type { WorkbenchDataStore } from '@duya/data/workbench-store';

/** Local authenticated projection over the Host-owned Workbench Data store. */
export function createHostLocalWorkbenchApi(store: WorkbenchDataStore): HostLocalWorkbenchApiV1 {
  return {
    async createDataSource(input) {
      return store.create(input);
    },
    async updateDataSource(id, patch) {
      return store.update(id, patch);
    },
    async deleteDataSource(id) {
      return store.delete(id);
    },
    async getDataSource(id) {
      return store.get(id);
    },
    async listDataSourcesByCanvas(canvasId) {
      return store.listByCanvas(canvasId);
    },
    async getCanvasProjectPath(canvasId) {
      return store.getCanvasProjectPath(canvasId);
    },
    async elementBelongsToCanvas(elementId, canvasId) {
      return store.elementBelongsToCanvas(elementId, canvasId);
    },
    async listDueDataSources(now, minimumIntervalSec) {
      return store.listDue(now, minimumIntervalSec);
    },
    async saveDataSourceRefresh(id, outcome) {
      store.saveRefresh(id, outcome);
    },
  };
}
