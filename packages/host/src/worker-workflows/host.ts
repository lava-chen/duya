/** Host bindings around the pure workflow contracts. */
export {
  BudgetExceededError,
  BudgetLedger,
  Semaphore,
  type BudgetTicket,
  type HostAgentSpec,
  type HostApprovalSpec,
  type HostCallContext,
  type HostCallResult,
  type WorkflowHost,
} from '@duya/workflow';

import * as os from 'node:os';

/** Legacy Host default retained for existing map-runner consumers. */
export function defaultConcurrency(): number {
  const cores = os.cpus().length || 4;
  return Math.min(32, Math.max(1, cores));
}
