/**
 * packages/cli/src/commands/gateway.ts
 *
 * `duya gateway` — IM gateway lifecycle control plane.
 *
 * Subcommands:
 *   status  — running state, pid, channel summary (read-only)
 *   start   — start the gateway subprocess; waits up to 30s for
 *             ready; --no-wait to skip the wait (Phase 7 write op)
 *   stop    — graceful stop (SIGTERM, SIGKILL fallback); idempotent
 *             (Phase 7 write op)
 *   restart — stop + start; waits up to 30s for ready
 *             (Phase 7 write op)
 *
 * All write ops require `--yes` in non-interactive mode. Audit log
 * entries distinguish the caller's origin via `X-Duya-Invoked-By`
 * (set by the API client when invoked from the `duya_cli` agent
 * tool with `invokedBy: 'agent-tool:{sessionId}'`).
 *
 * Data source: `electron/cli/handlers/gateway.ts` →
 *   GET  /v1/gateway
 *   POST /v1/gateway/start
 *   POST /v1/gateway/stop
 *   POST /v1/gateway/restart
 *
 * DTOs frozen in `electron/cli/handlers/gateway.ts` (gateway.ts
 * exports `GatewayStatusResponse`, `StartResult`, `StopResult`,
 * `RestartResult`). The CLI never reaches into agent or gateway
 * runtime modules — it only sees the typed bodies.
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTO mirrors (frozen, must match handlers/gateway.ts)
// ---------------------------------------------------------------------------

export interface GatewayStatusDTO {
  running: boolean;
  pid?: number;
  startedAt?: number;
  uptimeSec?: number;
  channelCount: number;
  channels: Array<{
    platform: string;
    id: string;
    name: string;
    bound: boolean;
  }>;
}

export interface GatewayStartResultDTO {
  ok: true;
  pid?: number;
  readyMs?: number;
  warning?: string;
}

export interface GatewayStopResultDTO {
  ok: true;
  stoppedMs: number;
  alreadyStopped?: boolean;
}

export interface GatewayRestartResultDTO {
  ok: true;
  pid?: number;
  readyMs?: number;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function renderStatusText(s: GatewayStatusDTO): string {
  const lines: string[] = [];
  if (s.running) {
    lines.push(`Gateway: running`);
    if (s.pid !== undefined) lines.push(`  pid:        ${s.pid}`);
    if (s.uptimeSec !== undefined) lines.push(`  uptime:     ${formatUptime(s.uptimeSec)}`);
  } else {
    lines.push(`Gateway: not running`);
  }
  lines.push(`  channels:   ${s.channelCount}`);
  if (s.channels.length > 0) {
    const platformWidth = Math.max(8, ...s.channels.map((c) => c.platform.length));
    const nameWidth = Math.max(4, ...s.channels.map((c) => c.name.length));
    for (const c of s.channels) {
      lines.push(
        `    ${c.platform.padEnd(platformWidth)} ${c.name.padEnd(nameWidth)} ${c.bound ? 'bound' : 'idle '}`,
      );
    }
  }
  return lines.join('\n');
}

function renderStartResultText(r: GatewayStartResultDTO): string {
  const parts: string[] = ['Gateway started.'];
  if (r.pid !== undefined) parts.push(`pid=${r.pid}`);
  if (r.readyMs !== undefined) parts.push(`ready in ${r.readyMs}ms`);
  if (r.warning) parts.push(`(warning: ${r.warning})`);
  return parts.join(' ');
}

function renderStopResultText(r: GatewayStopResultDTO): string {
  if (r.alreadyStopped) return 'Gateway was not running (idempotent stop).';
  return `Gateway stopped in ${r.stoppedMs}ms.`;
}

function renderRestartResultText(r: GatewayRestartResultDTO): string {
  const parts: string[] = ['Gateway restarted.'];
  if (r.pid !== undefined) parts.push(`pid=${r.pid}`);
  if (r.readyMs !== undefined) parts.push(`ready in ${r.readyMs}ms`);
  if (r.warning) parts.push(`(warning: ${r.warning})`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInteractive(): boolean {
  return Boolean(stdin.isTTY);
}

async function promptConfirm(message: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  return new Promise<boolean>((resolveYes) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolveYes(v === 'y' || v === 'yes');
    });
  });
}

async function guardWriteOp(action: string, yes: boolean): Promise<ExitCode | null> {
  if (!yes && !isInteractive()) {
    process.stderr.write(
      `interactive_required: ${action} requires --yes in non-interactive mode\n`,
    );
    return 3;
  }
  if (!yes) {
    const confirmed = await promptConfirm(`Confirm ${action}?`);
    if (!confirmed) {
      process.stderr.write(`aborted: ${action} cancelled\n`);
      return 1;
    }
  }
  return null;
}

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function statusGateway(format: OutputFormat): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<GatewayStatusDTO>('/v1/gateway');
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderStatusText(body) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function startGateway(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = await guardWriteOp('start gateway', ctx.options.yes === true);
  if (guard !== null) return guard;

  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<GatewayStartResultDTO>(
      '/v1/gateway/start',
      {},
      { correlationId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ ...body, correlationId }) + '\n');
    } else {
      process.stdout.write(renderStartResultText(body) + '\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function stopGateway(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = await guardWriteOp('stop gateway', ctx.options.yes === true);
  if (guard !== null) return guard;

  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<GatewayStopResultDTO>(
      '/v1/gateway/stop',
      {},
      { correlationId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ ...body, correlationId }) + '\n');
    } else {
      process.stdout.write(renderStopResultText(body) + '\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function restartGateway(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = await guardWriteOp('restart gateway', ctx.options.yes === true);
  if (guard !== null) return guard;

  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<GatewayRestartResultDTO>(
      '/v1/gateway/restart',
      {},
      { correlationId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ ...body, correlationId }) + '\n');
    } else {
      process.stdout.write(renderRestartResultText(body) + '\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// ---------------------------------------------------------------------------
// Public surface (consumed by descriptors.ts)
// ---------------------------------------------------------------------------

export const runGatewayCommand = {
  status: (ctx: CliSubcommandContext): Promise<ExitCode> => statusGateway(ctx.format),
  start: startGateway,
  stop: stopGateway,
  restart: restartGateway,
};
