/**
 * packages/agent/src/cli/commands/status.ts
 *
 * `duya status` — prints desktop app health from /v1/status.
 *
 * Supports:
 *   - `--format json|text` (default: text)
 *   - `--watch` (poll every 2s; Ctrl+C to stop)
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import { CliUserDataMissingError } from '../api/runtime-config.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

interface StatusBody {
  version: string;
  uptimeSec: number;
  dbReady: boolean;
  pluginReady: boolean;
  runtimePid: number;
  startedAt: number;
}

function renderText(body: StatusBody): string {
  const lines = [
    `DUYA ${body.version}`,
    `  pid:        ${body.runtimePid}`,
    `  uptime:     ${body.uptimeSec}s`,
    `  dbReady:    ${body.dbReady ? 'yes' : 'no'}`,
    `  pluginReady:${body.pluginReady ? 'yes' : 'no'}`,
    `  startedAt:  ${new Date(body.startedAt).toISOString()}`,
  ];
  return lines.join('\n');
}

async function fetchStatus(): Promise<StatusBody> {
  const client = await CliApiClient.connect();
  return client.get<StatusBody>('/v1/status');
}

function reportError(err: unknown): ExitCode {
  if (err instanceof CliUserDataMissingError) {
    process.stderr.write(err.message + '\n');
    return 2;
  }
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

export async function runStatusCommand(format: OutputFormat): Promise<number> {
  try {
    const body = await fetchStatus();
    process.stdout.write(format === 'json' ? renderJson(body) + '\n' : renderText(body) + '\n');
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

/**
 * Ctx-aware variant supporting `--watch`.
 */
export async function runStatusCommandCtx(ctx: CliSubcommandContext): Promise<ExitCode> {
  if (ctx.options.watch !== true) {
    return (await runStatusCommand(ctx.format)) as ExitCode;
  }
  // Watch loop: redraw in place; respect Ctrl+C.
  const interval = typeof ctx.options.interval === 'string'
    ? Math.max(250, Number(ctx.options.interval) || 2000)
    : 2000;
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    process.stdout.write('\n');
  });
  let lastJson = '';
  while (!stopped) {
    try {
      const body = await fetchStatus();
      if (ctx.format === 'json') {
        const j = renderJson(body);
        if (j !== lastJson) {
          process.stdout.write(j + '\n');
          lastJson = j;
        }
      } else {
        process.stdout.write('\x1b[2J\x1b[H'); // clear + home
        process.stdout.write(renderText(body) + '\n');
      }
    } catch (err) {
      return reportError(err);
    }
    await new Promise<void>((r) => setTimeout(r, interval));
  }
  return 0;
}
