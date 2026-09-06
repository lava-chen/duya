/**
 * electron/automation/types.ts
 *
 * Cron subsystem types. A cron job is a plain definition persisted in
 * `~/.duya/cronjob.toml` (single source of truth); runtime state
 * (lastRunAt / lastError / retryCount) is written back to the same file.
 * A cron run is an ordinary agent session (mode='chat', source='cron') whose
 * history lives in the session's rollout — there is no run table.
 */

export type ConcurrencyPolicy = 'skip' | 'parallel' | 'replace';
export type CronScheduleKind = 'once' | 'every' | 'cron';

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

// ==================== Event triggers (Plan 476 P2.3d, grok listener parity) ====================

/**
 * GitHub repository listener. Polling-based (duya is local-first — no cloud
 * relay), so the v1 event-kind whitelist excludes CI kinds whose REST
 * detection needs check-run fan-out. `userAllowlist` narrows events to
 * those involving the listed logins (pr events by PR owner, review events
 * by actor AND owner); empty/omitted = anyone.
 */
export interface GithubEventTrigger {
  type: 'github';
  /** `owner/name` — one concrete repo, no wildcard. */
  repo: string;
  events: string[];
  userAllowlist?: string[];
}

/**
 * Slack channel listener. `channel` is a channel id (C…) or a name with a
 * leading `#`/`@`; `match.kind` selects mention / keyword / any message.
 */
export interface SlackEventTrigger {
  type: 'slack';
  channel: string;
  match:
    | { kind: 'mention' }
    | { kind: 'message' }
    | { kind: 'keyword'; keyword: string };
}

export type RoutineEventTrigger = GithubEventTrigger | SlackEventTrigger;

/** A normalized outside event that a listener matched (grok event shape). */
export type RoutineEvent =
  | {
      source: 'github';
      repo: string;
      kind: string;
      title: string;
      actor: string;
      url?: string;
      prOwner?: string;
      timestampMs: number;
    }
  | {
      source: 'slack';
      channel: string;
      sender: string;
      text: string;
      isMention: boolean;
      ts: string;
      timestampMs: number;
    };

/** Per-listener poll cursor persisted in cronjob.toml (dedupe between ticks). */
export interface ListenerStateFile {
  index: number;
  cursor?: string;
  last_poll_at?: number;
}

/** A cron job: definition + runtime state, mirrored from cronjob.toml. */
export interface AutomationCron {
  id: string;
  name: string;
  prompt: string;
  /**
   * Time trigger. Null for event-only routines (they carry eventTriggers
   * instead); at least one of schedule / eventTriggers is always present.
   */
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
   * Bot binding (Plan 476 §2.3.1 / P2.3a): when set, this routine belongs
   * to the named agent (485 isSafeBotId slug) and fires into that bot's
   * resident session instead of a throwaway cron session. Null = classic
   * standalone cron (current behaviour, unchanged).
   */
  agent: string | null;
  /**
   * Event listeners (P2.3d): when non-empty, the listener hub polls the
   * backing SaaS APIs and fires the routine on a match. Schedules and
   * event triggers compose (grok group parity) — both fire the same prompt.
   */
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
  /** Time trigger; omit when the routine is event-only. */
  schedule?: CronSchedule;
  workingDirectory?: string;
  model?: string;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  enabled?: boolean;
  /** Bot binding slug (Plan 476 P2.3a); omit for a standalone cron. */
  agent?: string;
  /** Event listeners (P2.3d); at least one of schedule/eventTriggers required. */
  eventTriggers?: RoutineEventTrigger[];
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
  /** Set to null to clear an existing bot binding. */
  agent?: string | null;
  /** Replace the event listener set (grok update semantics: full list). */
  eventTriggers?: RoutineEventTrigger[];
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
