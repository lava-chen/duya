/**
 * packages/cli/src/commands/extra2.ts
 *
 * Phase 4.4: cron enable/disable/logs + gateway reload-secrets/rpc.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

function output(format: OutputFormat, json: unknown, text: string): void {
  process.stdout.write(format === 'json' ? renderJson(json) + '\n' : text + '\n');
}

function requireYes(ctx: CliSubcommandContext, action: string): ExitCode | null {
  if (ctx.options.yes === true || process.stdin.isTTY) return null;
  process.stderr.write(`interactive_required: ${action} requires --yes in non-interactive mode\n`);
  return 3;
}

// cron enable / disable
export async function runCronEnable(ctx: CliSubcommandContext): Promise<ExitCode> {
  return setCronEnabled(ctx, 'enable');
}

export async function runCronDisable(ctx: CliSubcommandContext): Promise<ExitCode> {
  return setCronEnabled(ctx, 'disable');
}

async function setCronEnabled(
  ctx: CliSubcommandContext,
  op: 'enable' | 'disable',
): Promise<ExitCode> {
  const guard = requireYes(ctx, `cron ${op}`);
  if (guard !== null) return guard;
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write(`usage: duya cron ${op} <id>\n`);
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; id: string; status: string; previousStatus: string }>(
      `/v1/crons/${encodeURIComponent(id)}/${op}`,
      {},
    );
    output(ctx.format, body, `${op}d ${body.id} (was ${body.previousStatus}, now ${body.status})\n`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// cron logs
export async function runCronLogs(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('usage: duya cron logs <id> [--limit 20]\n');
    return 64;
  }
  const limit = typeof ctx.options.limit === 'string' ? Number(ctx.options.limit) || 20 : 20;
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ id: string; runs: unknown[] }>(
      `/v1/crons/${encodeURIComponent(id)}/logs?limit=${limit}`,
    );
    process.stdout.write(renderJson(body) + '\n');
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// gateway reload-secrets
export async function runGatewayReloadSecrets(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; reason: string }>(
      '/v1/gateway/reload-secrets',
      {},
    );
    output(
      ctx.format,
      body,
      body.ok
        ? 'Gateway secrets reloaded.\n'
        : `gateway reload-secrets not implemented yet: ${body.reason}\n`,
    );
    return body.ok ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

// gateway rpc
export async function runGatewayRpc(ctx: CliSubcommandContext): Promise<ExitCode> {
  const method = ctx.args[0];
  if (!method) {
    process.stderr.write('usage: duya gateway rpc <method> [--params <json>]\n');
    return 64;
  }
  const paramsRaw = typeof ctx.options.params === 'string' ? ctx.options.params : undefined;
  let params: unknown = undefined;
  if (paramsRaw) {
    try {
      params = JSON.parse(paramsRaw);
    } catch (err) {
      process.stderr.write(`gateway rpc: --params is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
      return 64;
    }
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; method: string; reason: string }>(
      '/v1/gateway/rpc',
      { method, params },
    );
    output(
      ctx.format,
      body,
      body.ok
        ? `gateway rpc ${method} ok\n`
        : `gateway rpc not implemented yet: ${body.reason}\n`,
    );
    return body.ok ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}
