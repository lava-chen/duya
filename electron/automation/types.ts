export type CronScheduleKind = 'at' | 'every' | 'cron';
export type ConcurrencyPolicy = 'skip' | 'parallel' | 'queue' | 'replace';
export type CronStatus = 'enabled' | 'disabled' | 'error';
export type CronRunStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface CronSchedule {
  kind: CronScheduleKind;
  at?: string;
  everyMs?: number;
  cronExpr?: string;
  cronTz?: string | null;
  endAt?: string | null;
}

export interface AutomationCron {
  id: string;
  name: string;
  description: string | null;
  schedule_kind: CronScheduleKind;
  schedule_at: string | null;
  schedule_every_ms: number | null;
  schedule_cron_expr: string | null;
  schedule_cron_tz: string | null;
  schedule_end_at: string | null;
  workflow_id: string | null;
  working_directory: string;
  prompt: string;
  input_params: string;
  session_target: 'isolated';
  delivery_mode: 'none';
  status: CronStatus;
  model: string;
  last_run_at: number | null;
  next_run_at: number | null;
  last_error: string | null;
  retry_count: number;
  concurrency_policy: ConcurrencyPolicy;
  max_retries: number;
  created_at: number;
  updated_at: number;
}

export interface AutomationCronRun {
  id: string;
  cron_id: string;
  run_status: CronRunStatus;
  started_at: number | null;
  ended_at: number | null;
  output: string | null;
  error_message: string | null;
  logs: string | null;
  session_id: string | null;
  created_at: number;
}

export interface CreateAutomationCronInput {
  name: string;
  description?: string | null;
  workingDirectory?: string;
  schedule: CronSchedule;
  prompt: string;
  model: string;
  inputParams?: Record<string, unknown>;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  enabled?: boolean;
}

export interface UpdateAutomationCronInput {
  name?: string;
  description?: string | null;
  workingDirectory?: string;
  schedule?: CronSchedule;
  prompt?: string;
  model?: string;
  inputParams?: Record<string, unknown>;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  status?: CronStatus;
}

export interface ListCronRunsInput {
  cronId: string;
  limit?: number;
  offset?: number;
}

export interface AutomationTemplate {
  id: string;
  icon: string;
  label_en: string;
  label_zh: string;
  description_en: string;
  description_zh: string;
  prompt: string;
  defaultSchedule: CronSchedule;
  defaultModel?: string;
  tags: string[];
}

export interface AutomationTemplateConfig {
  version: string;
  templates: AutomationTemplate[];
}
