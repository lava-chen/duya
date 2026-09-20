/**
 * host.ts — WorkflowHost: the port layer between the deterministic
 * engine and the outside world (plan 415 §5.1/§5.4 + 552 §6.5).
 *
 * Every external effect — subagent spawn, tool execution, decision
 * request, approval request — goes through these ports, so the engine
 * stays a plain async function over the journal (determinism is the
 * breakpoint-resume precondition). Fixture tests substitute a fake
 * host; production wiring (Phase 4+) binds SubagentTool, ToolRegistry,
 * DecisionService and the 498 approval cards.
 *
 * Budget/concurrency separation (plan 552 §6.5, grok host_service form):
 * LLM-call budget walks reserve→spawn→release so a resume never
 * double-bills, and is independent of the concurrency semaphore. GUI
 * deterministic steps never consume agent budget — they only count
 * against the host-call cap.
 */

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import type { JournalRecord } from './journal.js';
import { WORKFLOW_BUDGET_DEFAULTS } from './schema.js';

export interface HostAgentSpec {
  agent: string;
  prompt: string;
  model?: string;
  /** Loose JSON-schema object; the host validates + 1 retry (§4.2 c). */
  outputSchema?: Record<string, unknown>;
}

export interface HostCallResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorClass?: string;
  /** Process exit code when the host surfaces one (bash-family tools). */
  exitCode?: number | null;
  /** Sub-agent DB session id (plan 504 lineage) — journal evidence link. */
  childSessionId?: string;
  /** Token usage when the host tracks it (agent/LLM calls). */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface HostApprovalSpec {
  nodeId: string;
  prompt: string;
  /** Epoch ms the host may wait before returning 'timeout'. */
  timeoutMs?: number;
}

export interface HostCallContext {
  runId: string;
  nodeId: string;
  /** Map fan-out item index (undefined for non-map calls). */
  itemIndex?: number;
}

export interface WorkflowHost {
  runAgent(spec: HostAgentSpec, ctx: HostCallContext): Promise<HostCallResult>;
  runTool(tool: string, input: unknown, ctx: HostCallContext): Promise<HostCallResult>;
  /** Human approval (498 card pipeline). Resolves approve/deny/timeout. */
  requestApproval(spec: HostApprovalSpec, ctx: HostCallContext): Promise<{ decision: 'approve' | 'deny' | 'timeout' }>;
  /** Optional per-record progress hook — the "report as you go" channel. */
  onJournalEvent?(record: JournalRecord): void;
}

// ─── budget ledger (reserve → spawn → release, §6.5) ───

export type BudgetTicket = { id: string; kind: 'agent' };

export class BudgetExceededError extends Error {
  constructor(
    readonly kind: 'agent' | 'host_call',
    readonly used: number,
    readonly limit: number,
  ) {
    super(`${kind} budget exceeded: ${used}/${limit}`);
    this.name = 'BudgetExceededError';
  }
}

export class BudgetLedger {
  private agentUsed = 0;
  private hostCallsUsed = 0;
  private readonly reservations = new Map<string, boolean>();

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

  /**
   * Reserve one agent call. Throws BudgetExceededError when the budget
   * is exhausted — the engine converts that into a journal-free stop.
   */
  reserveAgent(): BudgetTicket {
    if (this.agentUsed >= this.agentBudget) {
      throw new BudgetExceededError('agent', this.agentUsed, this.agentBudget);
    }
    this.agentUsed++;
    const ticket: BudgetTicket = { id: randomUUID(), kind: 'agent' };
    this.reservations.set(ticket.id, true);
    return ticket;
  }

  /** Release a reservation (failed spawn — no double billing on resume). */
  release(ticket: BudgetTicket): void {
    if (this.reservations.delete(ticket.id) && this.agentUsed > 0) {
      this.agentUsed--;
    }
  }

  /** Confirm a reservation: convert it into a final count (agent call happened). */
  commit(ticket: BudgetTicket): void {
    this.reservations.delete(ticket.id);
  }

  /** Count a non-agent host call (gui step, tool node). Throws at the cap. */
  countHostCall(): void {
    if (this.hostCallsUsed >= this.hostCallCap) {
      throw new BudgetExceededError('host_call', this.hostCallsUsed, this.hostCallCap);
    }
    this.hostCallsUsed++;
  }
}

// ─── concurrency semaphore (grok `semaphore` analogue) ───

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (limit < 1) throw new Error('semaphore limit must be >= 1');
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Default map concurrency: min(32, cores), capped by the node's own setting. */
export function defaultConcurrency(): number {
  const cores = os.cpus().length || 4;
  return Math.min(32, Math.max(1, cores));
}
