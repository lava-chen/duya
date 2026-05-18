/**
 * queries/crons.ts - Automation cron SQL queries
 *
 * Extracted from db-handlers.ts IPC handlers.
 * Cron operations primarily delegate to AutomationScheduler.
 * This module exposes typed wrappers for cron list/create/update/delete/run.
 */

// Note: Cron handlers in db-handlers.ts delegate to getAutomationScheduler().
// This module provides the interface but runtime delegation happens via
// the AutomationScheduler singleton, which manages its own DB access.
// To keep queries/ layer self-contained, the caller is responsible for
// providing the scheduler reference.

export interface AutomationCronRunRow {
  id: string;
  cronId: string;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  errorMessage: string | null;
}

export interface CronSchedule {
  kind: 'at' | 'every' | 'cron';
  at?: string;
  everyMs?: number;
  cronExpr?: string;
  cronTz?: string;
}

export interface CronInput {
  id: string;
  name: string;
  description?: string;
  model: string;
  schedule: CronSchedule;
  prompt: string;
  inputParams?: Record<string, unknown>;
  concurrencyPolicy?: 'replace' | 'discard' | 'queue';
  maxRetries?: number;
  enabled?: boolean;
}

export interface AutomationCronRow {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  prompt: string;
  model: string;
  input_params: string | null;
  concurrency_policy: string;
  max_retries: number;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Type for the scheduler dependency.
 * Matches AutomationScheduler interface without importing it directly.
 */
export interface ICronScheduler {
  listCrons(): AutomationCronRow[];
  createCron(input: CronInput): AutomationCronRow;
  updateCron(id: string, input: Partial<CronInput>): AutomationCronRow | null;
  deleteCron(id: string): boolean;
  runCron(id: string): Promise<{ sessionId: string }>;
  listCronRuns(input: { cronId?: string; limit?: number; offset?: number }): AutomationCronRunRow[];
}