/**
 * packages/agent/src/cli/commands/status.ts
 *
 * `duya status` — prints desktop app health from /v1/status.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import { CliUserDataMissingError } from '../api/runtime-config.js';

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

export async function runStatusCommand(format: OutputFormat): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<StatusBody>('/v1/status');
    process.stdout.write(format === 'json' ? renderJson(body) + '\n' : renderText(body) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof CliUserDataMissingError) {
      process.stderr.write(err.message + '\n');
      return 2;
    }
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
