import type { JournalRecord } from './journal.js';
import { WORKFLOW_BUDGET_DEFAULTS } from './schema.js';
import { ConcurrencyGate } from './scheduler.js';
import type { AimdConcurrencyGovernor } from './scheduler.js';

export interface HostAgentSpec {
  agent: string;
  prompt: string;
  model?: string | undefined;
  outputSchema?: Record<string, unknown> | undefined;
}

export interface HostCallResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorClass?: string;
  exitCode?: number | null;
  childSessionId?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface HostApprovalSpec {
  nodeId: string;
  prompt: string;
  timeoutMs?: number;
}

export interface HostCallContext {
  runId: string;
  nodeId: string;
  itemIndex?: number | undefined;
}

export interface WorkflowHost {
  runAgent(spec: HostAgentSpec, ctx: HostCallContext): Promise<HostCallResult>;
  /** Host returns a shared governor for the upstream provider selected for this agent call. */
  providerGovernorForAgent?(spec: HostAgentSpec): AimdConcurrencyGovernor | undefined;
  runTool(tool: string, input: unknown, ctx: HostCallContext): Promise<HostCallResult>;
  requestApproval(spec: HostApprovalSpec, ctx: HostCallContext): Promise<{ decision: 'approve' | 'deny' | 'timeout' }>;
  onJournalEvent?(record: JournalRecord): void;
}

export type BudgetTicket = { id: string; kind: 'agent' };

export class BudgetExceededError extends Error {
  constructor(readonly kind: 'agent' | 'host_call', readonly used: number, readonly limit: number) {
    super(`${kind} budget exceeded: ${used}/${limit}`);
    this.name = 'BudgetExceededError';
  }
}

/** Run budgets are independent of the concurrency gates. */
export class BudgetLedger {
  private agentUsed = 0;
  private hostCallsUsed = 0;
  private nextTicketId = 0;
  private readonly reservations = new Set<string>();

  constructor(
    readonly agentBudget: number = WORKFLOW_BUDGET_DEFAULTS.agentBudget,
    readonly hostCallCap: number = WORKFLOW_BUDGET_DEFAULTS.hostCallCap,
  ) {}

  get agentCallsUsed(): number {
    return this.agentUsed;
  }

  get hostCalls(): number {
    return this.hostCallsUsed;
  }

  reserveAgent(): BudgetTicket {
    if (this.agentUsed >= this.agentBudget) throw new BudgetExceededError('agent', this.agentUsed, this.agentBudget);
    this.agentUsed++;
    const ticket = { id: String(++this.nextTicketId), kind: 'agent' as const };
    this.reservations.add(ticket.id);
    return ticket;
  }

  release(ticket: BudgetTicket): void {
    if (this.reservations.delete(ticket.id) && this.agentUsed > 0) this.agentUsed--;
  }

  commit(ticket: BudgetTicket): void {
    this.reservations.delete(ticket.id);
  }

  countHostCall(): void {
    if (this.hostCallsUsed >= this.hostCallCap) {
      throw new BudgetExceededError('host_call', this.hostCallsUsed, this.hostCallCap);
    }
    this.hostCallsUsed++;
  }
}

/** Compatibility name for the map fan-out runner. */
export { ConcurrencyGate as Semaphore };
