/**
 * ManageRoutineTool — bot routine self-management (Plan 476 P2.3b; grok
 * `update_state` target "routine" parity on duya's cronjob.toml store).
 *
 * A routine is a saved prompt plus a trigger (today: a time schedule;
 * event listeners land with the listener hub). When it fires, the bot's
 * resident session (`bot:<agentId>`) wakes with a hidden `[routine]` turn
 * carrying the saved prompt — see electron/automation/routine-wake.ts.
 *
 * Ownership rule (SendToAgentTool precedent): the db-bridge has no session
 * context, so the tool derives the caller's bot id from its own session id
 * (`context.options.sessionId`) and enforces it — creates always bind the
 * routine to the CALLING bot, and update/pause/resume/delete/list only
 * ever touch routines whose stored `agent` equals that id. A non-bot
 * session has no routine identity and is refused.
 *
 * Persistence goes through the db-bridge `automation:cron:*` cases
 * (packages/agent/src/ipc/db-client.ts `automationDb`) — the agent
 * subprocess never writes cronjob.toml itself.
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ToolUseContext } from "../../types.js";
import { automationDb } from "../../ipc/db-client.js";
import { parseAgentIdFromBotSession } from "../../agent/dm/bot-session-id.js";
import { MANAGE_ROUTINE_TOOL_NAME, MAX_ROUTINES_PER_BOT } from "./constants.js";

export { MAX_ROUTINES_PER_BOT };

/** Schedule shape the tool accepts (mirrors electron CronSchedule). */
interface RoutineScheduleInput {
  kind: "every" | "once" | "cron";
  every?: string;
  at?: string;
  expr?: string;
  tz?: string | null;
  endAt?: string | null;
}

type RoutineAction = "create" | "update" | "pause" | "resume" | "delete" | "list";

const ACTIONS: readonly RoutineAction[] = ["create", "update", "pause", "resume", "delete", "list"];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ACTIONS,
      description:
        "create: save a new routine. update: rewrite an existing one in place (keeps its identity). pause / resume: disarm / rearm without deleting. delete: remove it. list: your routines with their ids and schedules.",
    },
    id: {
      type: "string",
      description:
        "Routine id — required for update / pause / resume / delete. Get ids from list.",
    },
    name: {
      type: "string",
      description: "Short human-readable name. Required for create; optional for update.",
    },
    prompt: {
      type: "string",
      description:
        "What you should do each time the routine fires, written to your future self as an intent (not a frozen tool recipe). Required for create; optional for update.",
    },
    schedule: {
      type: "object",
      description:
        "When to run. Required for create unless you pass triggers instead; optional for update. Shapes: { kind: 'cron', expr: '0 7 * * 1-5', tz? } (5-field cron), { kind: 'every', every: '30m' }, { kind: 'once', at: ISO date-time }.",
      properties: {
        kind: { type: "string", enum: ["cron", "every", "once"] },
        expr: { type: "string", description: "5-field cron expression (for kind 'cron')." },
        tz: { type: "string", description: "Optional IANA timezone for the cron expression." },
        every: { type: "string", description: "Interval like 30s / 5m / 2h / 1d (for kind 'every')." },
        at: { type: "string", description: "ISO date-time (for kind 'once')." },
        endAt: { type: "string", description: "Optional ISO date-time after which the routine stops." },
      },
      required: ["kind"],
    },
    triggers: {
      type: "array",
      description:
        "Event listeners INSTEAD of a schedule: fire when matching outside activity arrives. GitHub: { type: 'github', repo: 'owner/name', events: [...], userAllowlist?: [...] } with events from pr-opened, pr-merged, review-approved, review-changes-requested, review-commented, pr-comment, issue-assigned (CI events are not supported). Slack: { type: 'slack', channel: '#eng' or 'C123…' or '*', match: { kind: 'mention' } | { kind: 'keyword', keyword: 'deploy' } | { kind: 'message' } }. Listeners require the user to have connected the platform in App Connections; if it is not connected the listener stays silent — tell the user to connect it. Prefer a listener over polling on a timer whenever the event is representable. Mix with schedule on one routine is allowed.",
      items: { type: "object" },
    },
  },
  required: ["action"],
};

const TOOL_DESCRIPTION = `Create and manage routines — your scheduling feature. A routine is a saved prompt plus a trigger; when it fires, your session wakes with a hidden [routine] message and you carry out the saved prompt, then deliver the result with SendMessage. They run even when the user is away.

Be aggressive and proactive: the moment a request is recurring, time-based, or a "let me know when X" / "keep an eye on Y" need, create a routine instead of doing it once or trying to stay awake. When it is unambiguous, just create it and tell the user; when unsure, offer one in a sentence.

Schedule rules: choose the coarsest cadence that delivers the value at the moment the user will act on it. Weekday waking hours are the DEFAULT — pin day-of-week ("1-5") and an 8am-7pm hour range ("15 8 * * 1-5"), never leave both open; "@daily" fires at midnight and "@hourly" fires all night, so translate loose asks ("check daily", "every 30m") into a bounded cron instead. When the user names an hour but no minute, use the CURRENT minute off their message ("daily at 2" asked at 1:32 → "32 2 * * *"). Leave that window only for a reason you could say out loud — explicit "including weekends", genuinely time-critical subjects, or routines on the user's life (medication, habits), not merely because a feed produces around the clock.

Make every short-lived or conditional watch ("keep an eye on X", "until it merges") self-expiring: put a deadline in the prompt, delete the routine after reporting the watched condition, and delete it as soon as a run finds the deadline passed. Permanent routines are only for explicitly ongoing results (daily digest, standing reminder). Do not poll on a timer for Slack messages or repo events a trigger could deliver — but remember listeners do not wake on time, so a deadline that must be enforced even when the event never arrives belongs on a cron schedule instead.

If a routine keeps failing on auth (an integration or tool rejects you on run after run — your own earlier messages are the record), pause it and tell the user what to reconnect instead of reporting the same failure every fire. To change or stop one: update / pause / resume / delete by id from list. Confirm to the user once saved or changed.`;

function result(text: string, error?: boolean): ToolResult {
  return {
    id: randomUUID(),
    name: MANAGE_ROUTINE_TOOL_NAME,
    result: text,
    ...(error !== undefined ? { error } : {}),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asSchedule(value: unknown): RoutineScheduleInput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "every" && record.kind !== "once" && record.kind !== "cron") return undefined;
  const schedule: RoutineScheduleInput = { kind: record.kind };
  if (typeof record.every === "string") schedule.every = record.every;
  if (typeof record.at === "string") schedule.at = record.at;
  if (typeof record.expr === "string") schedule.expr = record.expr;
  if (typeof record.tz === "string" || record.tz === null) schedule.tz = record.tz as string | null;
  if (typeof record.endAt === "string" || record.endAt === null) schedule.endAt = record.endAt as string | null;
  return schedule;
}

/**
 * Event listener list passthrough: absent → undefined (no-op); an array is
 * passed through object-by-object — deep validation (repo shape, event
 * whitelist, channel bounds) happens main-side in the store, which throws
 * with the reason that surfaces to the model.
 */
function asTriggerList(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function describeTriggerSpec(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  if (record.type === "github") {
    const events = Array.isArray(record.events) ? record.events.join("/") : "events";
    return `github ${String(record.repo ?? "?")} (${events})`;
  }
  if (record.type === "slack") {
    const match = typeof record.match === "object" && record.match !== null ? (record.match as Record<string, unknown>) : {};
    return `slack ${String(record.channel ?? "?")} (${String(match.kind ?? "message")})`;
  }
  return "";
}

function describeCron(job: {
  id: string;
  name: string;
  enabled: boolean;
  schedule?: RoutineScheduleInput | null;
  eventTriggers?: Array<Record<string, unknown>>;
  lastRunAt: number | null;
  lastError: string | null;
}): string {
  const state = job.enabled ? "enabled" : "paused";
  const schedule = job.schedule;
  let when: string;
  if (schedule == null) {
    when = "";
  } else if (schedule.kind === "once") {
    when = `once at ${schedule.at ?? "?"}`;
  } else if (schedule.kind === "every") {
    when = `every ${schedule.every ?? "?"}`;
  } else {
    when = `cron "${schedule.expr ?? "?"}"${schedule.tz ? ` (${schedule.tz})` : ""}`;
  }
  const triggers = (job.eventTriggers ?? []).map(describeTriggerSpec).filter(Boolean);
  if (triggers.length > 0) {
    when = `${when ? `${when} or ` : ""}when ${triggers.join(" or ")}`;
  }
  const lastRun = job.lastRunAt != null ? `; last run ${new Date(job.lastRunAt).toLocaleString()}` : "";
  const lastErr = job.lastError ? `; last error: ${job.lastError}` : "";
  return `- ${job.name} (id ${job.id}) [${state}] — ${when}${lastRun}${lastErr}`;
}

export class ManageRoutineTool implements Tool {
  readonly name = MANAGE_ROUTINE_TOOL_NAME;
  readonly description = TOOL_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = INPUT_SCHEMA;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const action = asString(input.action) as RoutineAction | undefined;
    if (!action || !ACTIONS.includes(action)) {
      return result(`Error: action must be one of ${ACTIONS.join(", ")}.`, true);
    }

    // Ownership: the caller's bot id comes from its own persistent session
    // id (`bot:<agentId>`). Non-bot sessions have no routine identity.
    const rawSessionId = context?.options?.sessionId || process.env.SESSION_ID || "";
    const selfAgentId = parseAgentIdFromBotSession(rawSessionId);
    if (!selfAgentId) {
      return result(
        "Error: routines belong to bots. Routines you create fire into your own resident session while the user is away; this session is not a bot resident session, so it cannot own one.",
        true,
      );
    }

    try {
      switch (action) {
        case "create":
          return await this.create(input, selfAgentId);
        case "update":
          return await this.update(input, selfAgentId);
        case "pause":
        case "resume":
          return await this.setEnabled(input, selfAgentId, action === "resume");
        case "delete":
          return await this.delete(input, selfAgentId);
        case "list":
          return await this.list(selfAgentId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return result(`Failed to ${action} routine: ${message}`, true);
    }
  }

  private async create(input: Record<string, unknown>, selfAgentId: string): Promise<ToolResult> {
    const name = asString(input.name)?.trim();
    const prompt = asString(input.prompt)?.trim();
    const schedule = asSchedule(input.schedule);
    const triggers = asTriggerList(input.triggers);
    if (!name) return result("Error: name is required. Give the routine a short, human-readable name.", true);
    if (!prompt) return result("Error: prompt is required. Write what you should do each time, as an intent to your future self.", true);
    if (!schedule && !triggers) {
      return result(
        "Error: a trigger is required. Pass schedule ({ kind: 'cron', expr } / { kind: 'every', every } / { kind: 'once', at }) or triggers (github/slack listeners).",
        true,
      );
    }
    if (schedule?.kind === "cron" && !schedule.expr?.trim()) {
      return result("Error: schedule.expr (5-field cron expression) is required for kind 'cron'.", true);
    }
    if (schedule?.kind === "every" && !schedule.every?.trim()) {
      return result("Error: schedule.every (like '30m' or '1h') is required for kind 'every'.", true);
    }
    if (schedule?.kind === "once" && !schedule.at?.trim()) {
      return result("Error: schedule.at (ISO date-time) is required for kind 'once'.", true);
    }
    if (typeof input.triggers !== "undefined" && triggers === undefined) {
      return result(
        "Error: triggers must be an array of listener specs — { type: 'github', repo: 'owner/name', events: [...] } or { type: 'slack', channel, match: { kind: 'mention' | 'keyword' | 'message', keyword? } }.",
        true,
      );
    }

    const owned = await this.listOwned(selfAgentId);
    if (owned.length >= MAX_ROUTINES_PER_BOT) {
      return result(
        `Error: you already own ${MAX_ROUTINES_PER_BOT} routines (the limit). Delete one before creating another.`,
        true,
      );
    }

    const created = await automationDb.createCron({
      name,
      prompt,
      ...(schedule
        ? {
            schedule: {
              kind: schedule.kind,
              ...(schedule.kind === "every" ? { every: schedule.every } : {}),
              ...(schedule.kind === "once" ? { at: schedule.at } : {}),
              ...(schedule.kind === "cron" ? { expr: schedule.expr } : {}),
              ...(schedule.tz != null ? { tz: schedule.tz } : {}),
              ...(schedule.endAt != null ? { endAt: schedule.endAt } : {}),
            },
          }
        : {}),
      ...(triggers ? { eventTriggers: triggers } : {}),
      // Always bind the routine to the CALLING bot — never trust a caller
      // supplied agent value.
      agent: selfAgentId,
      enabled: true,
    });
    return result(
      `Created routine "${created.name}" (id ${created.id}). Confirm it to the user once.`,
    );
  }

  private async update(input: Record<string, unknown>, selfAgentId: string): Promise<ToolResult> {
    const id = asString(input.id)?.trim();
    if (!id) return result("Error: id is required for update (use list to find it).", true);
    const owned = await this.listOwned(selfAgentId);
    const existing = owned.find((job) => job.id === id);
    if (!existing) {
      return result(`No routine with id ${id} belongs to you. Use list to see your routines.`, true);
    }

    const name = asString(input.name)?.trim();
    const prompt = asString(input.prompt)?.trim();
    const schedule = asSchedule(input.schedule);
    const triggers = asTriggerList(input.triggers);
    if (!name && !prompt && !schedule && triggers === undefined) {
      return result("Nothing to update: provide a new name, prompt, schedule, and/or triggers.");
    }

    const updated = await automationDb.updateCron(id, {
      ...(name ? { name } : {}),
      ...(prompt ? { prompt } : {}),
      ...(schedule
        ? {
            schedule: {
              kind: schedule.kind,
              ...(schedule.kind === "every" ? { every: schedule.every } : {}),
              ...(schedule.kind === "once" ? { at: schedule.at } : {}),
              ...(schedule.kind === "cron" ? { expr: schedule.expr } : {}),
              ...(schedule.tz != null ? { tz: schedule.tz } : {}),
              ...(schedule.endAt != null ? { endAt: schedule.endAt } : {}),
            } as RoutineScheduleInput,
          }
        : {}),
      ...(triggers !== undefined ? { eventTriggers: triggers } : {}),
    });
    return result(`Updated routine "${updated.name}" (id ${updated.id}). It keeps its history.`);
  }

  private async setEnabled(input: Record<string, unknown>, selfAgentId: string, enabled: boolean): Promise<ToolResult> {
    const id = asString(input.id)?.trim();
    if (!id) return result(`Error: id is required for ${enabled ? "resume" : "pause"} (use list to find it).`, true);
    const owned = await this.listOwned(selfAgentId);
    if (!owned.some((job) => job.id === id)) {
      return result(`No routine with id ${id} belongs to you. Use list to see your routines.`, true);
    }
    const updated = await automationDb.updateCron(id, { enabled });
    return result(
      `${enabled ? "Resumed" : "Paused"} routine "${updated.name}" (id ${updated.id}).${enabled ? "" : " It stays listed but will not fire until resumed."}`,
    );
  }

  private async delete(input: Record<string, unknown>, selfAgentId: string): Promise<ToolResult> {
    const id = asString(input.id)?.trim();
    if (!id) return result("Error: id is required for delete (use list to find it).", true);
    const owned = await this.listOwned(selfAgentId);
    const existing = owned.find((job) => job.id === id);
    if (!existing) {
      return result(`No routine with id ${id} belongs to you. Use list to see your routines.`, false);
    }
    await automationDb.deleteCron(id);
    return result(`Deleted routine "${existing.name}" (id ${id}).`);
  }

  private async list(selfAgentId: string): Promise<ToolResult> {
    const owned = await this.listOwned(selfAgentId);
    if (owned.length === 0) {
      return result("You have no routines yet.");
    }
    const lines = owned.map((job) => describeCron(job));
    return result(`Your routines:\n${lines.join("\n")}`);
  }

  private async listOwned(selfAgentId: string): Promise<
    Array<{
      id: string;
      name: string;
      enabled: boolean;
      schedule?: RoutineScheduleInput | null;
      eventTriggers?: Array<Record<string, unknown>>;
      lastRunAt: number | null;
      lastError: string | null;
    }>
  > {
    const crons = (await automationDb.listCrons()) as Array<Record<string, unknown>>;
    return crons
      .filter((job) => job.agent === selfAgentId)
      .map((job) => ({
        id: String(job.id),
        name: String(job.name),
        enabled: job.enabled === true,
        schedule: (job.schedule ?? null) as RoutineScheduleInput | null,
        eventTriggers: Array.isArray(job.eventTriggers)
          ? (job.eventTriggers as Array<Record<string, unknown>>)
          : undefined,
        lastRunAt: typeof job.lastRunAt === "number" ? job.lastRunAt : null,
        lastError: typeof job.lastError === "string" ? job.lastError : null,
      }));
  }
}

export const manageRoutineTool = new ManageRoutineTool();
