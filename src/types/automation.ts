/**
 * src/types/automation.ts
 *
 * Renderer-side mirror of `electron/automation/types.ts`. Keep the two in
 * lockstep. A cron run is an ordinary agent session (mode='chat', source='cron')
 * whose history lives in the session transcript; there is no run table.
 */

export type ConcurrencyPolicy = 'skip' | 'parallel' | 'replace';
export type CronScheduleKind = 'once' | 'every' | 'cron';

/** Event listener specs (P2.3d) — shape validated main-side. */
export interface GithubEventTrigger {
  type: 'github';
  repo: string;
  events: string[];
  userAllowlist?: string[];
}
export interface SlackEventTrigger {
  type: 'slack';
  channel: string;
  match: { kind: 'mention' } | { kind: 'message' } | { kind: 'keyword'; keyword: string };
}
export type RoutineEventTrigger = GithubEventTrigger | SlackEventTrigger;

export interface CronEverySchedule {
  kind: 'every';
  every: string; // human-friendly duration: "5m", "1h", "1d"
  endAt?: string | null;
}
export interface CronOnceSchedule {
  kind: 'once';
  at: string; // ISO date-time
  endAt?: string | null;
}
export interface CronExprSchedule {
  kind: 'cron';
  expr: string; // 5-field cron expression
  tz?: string | null;
  endAt?: string | null;
}
export type CronSchedule = CronEverySchedule | CronOnceSchedule | CronExprSchedule;

/** A cron job: definition + runtime state, mirrored from cronjob.toml. */
export interface AutomationCron {
  id: string;
  name: string;
  prompt: string;
  /** Time trigger; null for event-only routines (they carry eventTriggers). */
  schedule: CronSchedule | null;
  workingDirectory: string;
  model: string;
  enabled: boolean;
  concurrencyPolicy: ConcurrencyPolicy;
  maxRetries: number;
  lastRunAt: number | null;
  lastError: string | null;
  retryCount: number;
  /**
   * Bot binding (Plan 476 P2.3b): when set, this routine belongs to the
   * named bot and fires into its resident session. Null = standalone cron.
   */
  agent?: string | null;
  /** Event listeners (P2.3d); at least one of schedule/eventTriggers exists. */
  eventTriggers?: RoutineEventTrigger[];
  /** Computed on read from (schedule, lastRunAt, now); not persisted. */
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Returned by `runCronNow` so the caller can open the run view immediately. */
export interface CronRunHandle {
  runId: string;
  sessionId: string;
  cronId: string;
}

/** One cron session (one scheduled run) as shown in the history panel. */
export interface CronSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messageCount: number;
}

export interface CreateAutomationCronInput {
  name: string;
  prompt: string;
  schedule: CronSchedule;
  workingDirectory?: string;
  model?: string;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  enabled?: boolean;
  /** Bot binding slug (Plan 476 P2.3b); omit for a standalone cron. */
  agent?: string;
}

export interface UpdateAutomationCronInput {
  name?: string;
  prompt?: string;
  schedule?: CronSchedule;
  workingDirectory?: string;
  model?: string;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  enabled?: boolean;
  /** Omitted fields (including the bot binding) are preserved on update. */
  agent?: string | null;
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

export interface ParsedAutomationConfig {
  name: string;
  prompt: string;
  schedule: CronSchedule;
  project?: string;
  model?: string;
}
