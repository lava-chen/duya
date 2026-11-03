/** Bind the project capability to the Host project tool service. */
import { ProjectTool as CapabilityProjectTool, type ProjectToolPort } from '@duya/capabilities/project';
import { createWorkerProjectToolPort } from '@duya/host/worker-tool-services/project';

export class ProjectTool extends CapabilityProjectTool {
  constructor(port: ProjectToolPort = createWorkerProjectToolPort()) {
    super(port);
  }
}

export const projectTool = new ProjectTool();
