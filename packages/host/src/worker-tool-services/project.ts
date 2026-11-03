import type {
  ProjectToolOperation,
  ProjectToolPayload,
  ProjectToolPort,
} from '@duya/capabilities/project';
import { projectDb } from '../worker-db-client.js';

/** Bind the capability's project actions to the worker DB bridge. */
export function createWorkerProjectToolPort(): ProjectToolPort {
  return {
    async dispatch(input) {
      return await projectDb.tool(input) as ProjectToolOperation<ProjectToolPayload>;
    },
  };
}
