import type { AssistantMode } from '@duya/agent-protocol';
import type { ModeToolPort, PlanFileSeedStatus } from '@duya/capabilities/mode-tools';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { resolvePlanFilePath } from '../worker-modes/plan/plan-file-path.js';
import { planModeTracker, type PlanModeEvent } from '../worker-modes/plan/plan-tracker.js';

export interface WorkerModeSwitchDependencies {
  resolvePlanFilePath(sessionId: string): string;
  transitionPlanMode(event: Extract<PlanModeEvent, 'activate_from_tool' | 'exit_approved'>): void;
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<unknown>;
}

const defaultDependencies: WorkerModeSwitchDependencies = {
  resolvePlanFilePath,
  transitionPlanMode: (event) => { planModeTracker.transition(event); },
  readFile: (path, encoding) => readFile(path, encoding),
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
};

export class WorkerModeSwitchService implements ModeToolPort {
  private currentMode: AssistantMode = 'general';

  constructor(private readonly dependencies: WorkerModeSwitchDependencies = defaultDependencies) {}

  getCurrentMode(): AssistantMode {
    return this.currentMode;
  }

  setAgentMode(mode: AssistantMode): void {
    this.currentMode = mode;
  }

  isReadOnlyMode(): boolean {
    return this.currentMode !== 'general';
  }

  transitionPlanMode(event: 'activate_from_tool' | 'exit_approved'): void {
    this.dependencies.transitionPlanMode(event);
  }

  resolvePlanFilePath(sessionId: string): string {
    return this.dependencies.resolvePlanFilePath(sessionId);
  }

  async probeOrCreateEmptyPlanFile(sessionId: string): Promise<PlanFileSeedStatus> {
    const planPath = this.resolvePlanFilePath(sessionId);
    try {
      const content = await this.dependencies.readFile(planPath, 'utf-8');
      return content.length === 0 ? 'empty' : 'non_empty';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'missing';
      try {
        await this.dependencies.mkdir(dirname(planPath), { recursive: true });
        await this.dependencies.writeFile(planPath, '', 'utf-8');
        return 'empty';
      } catch {
        return 'missing';
      }
    }
  }
}

export function createWorkerModeSwitchService(
  dependencies: WorkerModeSwitchDependencies = defaultDependencies,
): WorkerModeSwitchService {
  return new WorkerModeSwitchService(dependencies);
}

let singleton: WorkerModeSwitchService | undefined;

export function getWorkerModeSwitchService(): WorkerModeSwitchService {
  singleton ??= createWorkerModeSwitchService();
  return singleton;
}

export function resetWorkerModeSwitchService(): void {
  singleton = undefined;
}
