import { z } from 'zod/v4';
import { automationDb } from '../../ipc/db-client.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { CRON_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';

const actionSchema = z.enum(['status', 'list', 'create', 'add', 'update', 'delete', 'remove', 'run', 'runs']);

const inputSchema = z.object({
  action: actionSchema,
  id: z.string().optional(),
  jobId: z.string().optional(),
  cronId: z.string().optional(),
  cron: z.record(z.string(), z.unknown()).optional(),
  job: z.record(z.string(), z.unknown()).optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  includeDisabled: z.boolean().optional(),
});

type CronInput = z.infer<typeof inputSchema>;

type ScheduleKind = 'at' | 'every' | 'cron';
type ConcurrencyPolicy = 'skip' | 'parallel' | 'queue' | 'replace';

type CreateCronInput = {
  name: string;
  description?: string | null;
  schedule: { kind: ScheduleKind; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
  prompt: string;
  inputParams?: Record<string, unknown>;
  concurrencyPolicy?: ConcurrencyPolicy;
  maxRetries?: number;
  enabled?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveCronId(input: CronInput): string | undefined {
  return input.id || input.jobId || input.cronId;
}

function normalizeSchedule(raw: Record<string, unknown>): CreateCronInput['schedule'] {
  const kindRaw = asString(raw.kind);
  const kind: ScheduleKind = kindRaw === 'at' || kindRaw === 'every' || kindRaw === 'cron' ? kindRaw : 'every';
  if (kind === 'at') {
    return { kind: 'at', at: asString(raw.at) };
  }
  if (kind === 'every') {
    return { kind: 'every', everyMs: asNumber(raw.everyMs) };
  }
  return {
    kind: 'cron',
    cronExpr: asString(raw.cronExpr) || asString(raw.expr) || asString(raw.cron),
    cronTz: asNullableString(raw.cronTz) ?? asNullableString(raw.tz) ?? null,
  };
}

function normalizeCreateInput(raw: Record<string, unknown>): CreateCronInput {
  const payload = asRecord(raw.payload);
  const scheduleRaw = asRecord(raw.schedule) ?? {};

  const prompt =
    asString(raw.prompt) ||
    asString(raw.message) ||
    asString(payload?.message) ||
    asString(payload?.text) ||
    '';
  if (!prompt.trim()) {
    throw new Error('prompt is required (or payload.message for OpenClaw-style input)');
  }

  const sessionTarget = asString(raw.sessionTarget);
  if (sessionTarget && sessionTarget !== 'isolated') {
    throw new Error('Phase 1 only supports sessionTarget="isolated"');
  }
  const delivery = asRecord(raw.delivery);
  const deliveryMode = asString(delivery?.mode);
  if (deliveryMode && deliveryMode !== 'none') {
    throw new Error('Phase 1 only supports delivery.mode="none"');
  }

  const name = asString(raw.name)?.trim() || `Cron ${new Date().toISOString()}`;

  return {
    name,
    description: asNullableString(raw.description),
    schedule: normalizeSchedule(scheduleRaw),
    prompt,
    inputParams: asRecord(raw.inputParams) || asRecord(raw.input_params) || undefined,
    concurrencyPolicy: (() => {
      const policy = asString(raw.concurrencyPolicy) || asString(raw.concurrency_policy);
      return policy === 'skip' || policy === 'parallel' || policy === 'queue' || policy === 'replace'
        ? policy
        : undefined;
    })(),
    maxRetries: asNumber(raw.maxRetries) ?? asNumber(raw.max_retries),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
  };
}

function normalizeUpdatePatch(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  if (raw.name !== undefined) normalized.name = raw.name;
  if (raw.description !== undefined) normalized.description = raw.description;
  if (raw.schedule !== undefined) {
    const scheduleRaw = asRecord(raw.schedule);
    if (!scheduleRaw) throw new Error('patch.schedule must be an object');
    normalized.schedule = normalizeSchedule(scheduleRaw);
  }

  const payload = asRecord(raw.payload);
  const prompt =
    asString(raw.prompt) ||
    asString(raw.message) ||
    asString(payload?.message) ||
    asString(payload?.text);
  if (prompt !== undefined) normalized.prompt = prompt;

  if (raw.inputParams !== undefined || raw.input_params !== undefined) {
    normalized.inputParams = asRecord(raw.inputParams) || asRecord(raw.input_params) || {};
  }
  if (raw.concurrencyPolicy !== undefined || raw.concurrency_policy !== undefined) {
    normalized.concurrencyPolicy = raw.concurrencyPolicy ?? raw.concurrency_policy;
  }
  if (raw.maxRetries !== undefined || raw.max_retries !== undefined) {
    normalized.maxRetries = raw.maxRetries ?? raw.max_retries;
  }
  if (raw.status !== undefined) {
    normalized.status = raw.status;
  } else if (raw.enabled !== undefined) {
    normalized.status = raw.enabled ? 'enabled' : 'disabled';
  }
  return normalized;
}

function toolSuccess(result: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: CRON_TOOL_NAME,
    result: JSON.stringify(result, null, 2),
  };
}

function toolError(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: CRON_TOOL_NAME,
    result: JSON.stringify({ error: message }),
    error: true,
  };
}

export class CronTool implements Tool, ToolExecutor {
  readonly name = CRON_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'list', 'create', 'add', 'update', 'delete', 'remove', 'run', 'runs'],
        description: 'Cron action',
      },
      id: { type: 'string', description: 'Cron ID (aliases: jobId, cronId)' },
      jobId: { type: 'string', description: 'Cron ID alias for compatibility' },
      cronId: { type: 'string', description: 'Cron ID alias' },
      cron: { type: 'object', description: 'Create payload (alias: job)' },
      job: { type: 'object', description: 'OpenClaw-style create payload alias' },
      patch: { type: 'object', description: 'Update patch payload' },
      limit: { type: 'number', description: 'Run list page size' },
      offset: { type: 'number', description: 'Run list offset' },
      includeDisabled: { type: 'boolean', description: 'Include disabled jobs in list' },
    },
    required: ['action'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError(`Invalid input: ${parsed.error.message}`);
    }

    const data = parsed.data;
    try {
      switch (data.action) {
        case 'status': {
          const list = await automationDb.listCrons() as Array<{ status?: string }>;
          const counts = list.reduce(
            (acc, item) => {
              const key = item.status === 'enabled' || item.status === 'disabled' || item.status === 'error'
                ? item.status
                : 'other';
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>,
          );
          return toolSuccess({ total: list.length, counts });
        }
        case 'list': {
          const list = await automationDb.listCrons() as Array<Record<string, unknown>>;
          if (data.includeDisabled) return toolSuccess(list);
          return toolSuccess(list.filter((item) => item.status !== 'disabled'));
        }
        case 'create':
        case 'add': {
          const raw = asRecord(data.cron) || asRecord(data.job);
          if (!raw) return toolError('cron/job payload is required for create/add');
          const created = await automationDb.createCron(normalizeCreateInput(raw));
          return toolSuccess(created);
        }
        case 'update': {
          const id = resolveCronId(data);
          if (!id) return toolError('id/jobId/cronId is required for update');
          const patch = asRecord(data.patch);
          if (!patch) return toolError('patch payload is required for update');
          const updated = await automationDb.updateCron(id, normalizeUpdatePatch(patch));
          return toolSuccess(updated);
        }
        case 'delete':
        case 'remove': {
          const id = resolveCronId(data);
          if (!id) return toolError('id/jobId/cronId is required for delete/remove');
          const result = await automationDb.deleteCron(id);
          return toolSuccess(result);
        }
        case 'run': {
          const id = resolveCronId(data);
          if (!id) return toolError('id/jobId/cronId is required for run');
          const result = await automationDb.runCron(id);
          return toolSuccess(result);
        }
        case 'runs': {
          const id = resolveCronId(data);
          if (!id) return toolError('id/jobId/cronId is required for runs');
          const result = await automationDb.listCronRuns({
            cronId: id,
            limit: data.limit,
            offset: data.offset,
          });
          return toolSuccess(result);
        }
        default:
          return toolError(`Unsupported action: ${data.action}`);
      }
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  getPrompt(): string {
    return getPrompt();
  }
}

export const cronTool = new CronTool();
