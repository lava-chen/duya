/** Host constructor adapter for the pure workflow engine. */
import {
  WorkflowEngine as WorkflowEngineCore,
  type EngineOptions as WorkflowEngineOptions,
  type WorkflowDecisionPort,
  type WorkflowRuntimePorts,
} from '@duya/workflow';
import type { DecisionService } from '../decisions/index.js';
import { WorkflowDecisionAdapter } from './decision-adapter.js';
import { createWorkflowRuntimePorts } from './runtime-ports.js';
import { defaultConcurrency } from './host.js';

export type EngineOptions = Omit<WorkflowEngineOptions, 'ports' | 'decisions'> & {
  decisionService?: DecisionService | undefined;
  decisions?: WorkflowDecisionPort | undefined;
  ports?: WorkflowRuntimePorts | undefined;
  /** Host HMAC secret retained for source compatibility. */
  secret?: string | undefined;
};

export class WorkflowEngine extends WorkflowEngineCore {
  constructor(options: EngineOptions) {
    const { decisionService, decisions, ports, secret, ...coreOptions } = options;
    super({
      ...coreOptions,
      concurrency: options.concurrency ?? defaultConcurrency(),
      ports: ports ?? createWorkflowRuntimePorts(secret),
      ...(decisions !== undefined
        ? { decisions }
        : decisionService !== undefined
          ? { decisions: new WorkflowDecisionAdapter(decisionService) }
          : {}),
    });
  }
}

export type { EngineOutcome, ExecuteOptions } from '@duya/workflow';
