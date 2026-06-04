/**
 * packages/cli/src/commands/update.ts
 *
 * `duya update` — manage the desktop app's auto-update flow.
 *
 * Subcommands:
 *   status  — show the current updater state (read-only)
 *   check   — kick off a check; reports available version
 *   download — start downloading the latest update (--yes gated)
 *   install — quit the desktop app and install the downloaded update
 *             (--yes gated; the app will restart)
 *
 * Data source: `electron/cli/handlers/update.ts` →
 *   GET  /v1/update/status
 *   POST /v1/update/check
 *   POST /v1/update/download
 *   POST /v1/update/install
 *
 * Exits non-zero when the underlying IPC call fails or when a
 * destructive write op is invoked without --yes in non-interactive mode.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTO mirrors (frozen, must match handlers/update.ts)
// ---------------------------------------------------------------------------

export interface UpdateStatusDTO {
  currentVersion: string;
  isChecking: boolean;
  isDownloading: boolean;
  updateAvailable: boolean;
  updateInfo: {
    version: string;
    releaseDate: string | null;
  } | null;
  downloadProgress: {
    percent: number;
    transferred: number;
    total: number;
  } | null;
  error: string | null;
}

export interface UpdateCheckResultDTO {
  success: boolean;
  updateAvailable?: boolean;
  error?: string;
  currentVersion: string;
}

export interface UpdateDownloadResultDTO {
  success: boolean;
  error?: string;
}

export interface UpdateInstallResultDTO {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

function renderStatusText(s: UpdateStatusDTO): string {
  const lines: string[] = [];
  lines.push(`DUYA ${s.currentVersion}`);
  lines.push(`  checking:    ${s.isChecking ? 'yes' : 'no'}`);
  lines.push(`  downloading: ${s.isDownloading ? 'yes' : 'no'}`);
  if (s.updateInfo) {
    lines.push(`  available:   ${s.updateInfo.version}`);
    if (s.updateInfo.releaseDate) {
      lines.push(`  releasedAt:  ${s.updateInfo.releaseDate}`);
    }
  } else {
    lines.push(`  available:   no`);
  }
  if (s.downloadProgress) {
    lines.push(
      `  progress:    ${s.downloadProgress.percent}% (${s.downloadProgress.transferred}/${s.downloadProgress.total} bytes)`,
    );
  }
  if (s.error) lines.push(`  error:       ${s.error}`);
  return lines.join('\n');
}

function renderCheckResultText(r: UpdateCheckResultDTO): string {
  if (!r.success) return `Update check failed: ${r.error ?? 'unknown error'}`;
  if (r.updateAvailable) return `Update available. Run \`duya update download\` to fetch it.`;
  return `DUYA ${r.currentVersion} is up to date.`;
}

function renderDownloadResultText(r: UpdateDownloadResultDTO): string {
  if (!r.success) return `Download failed: ${r.error ?? 'unknown error'}`;
  return 'Download started. Watch the desktop UI for progress, or run `duya update status`.';
}

function renderInstallResultText(r: UpdateInstallResultDTO): string {
  return r.message || 'Restarting to install update…';
}

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

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

export async function runUpdateStatus(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<UpdateStatusDTO>('/v1/update/status');
    process.stdout.write(
      ctx.format === 'json' ? renderJson(body) + '\n' : renderStatusText(body) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function runUpdateCheck(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<UpdateCheckResultDTO>('/v1/update/check', {});
    process.stdout.write(
      ctx.format === 'json' ? renderJson(body) + '\n' : renderCheckResultText(body) + '\n',
    );
    return body.success ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runUpdateDownload(ctx: CliSubcommandContext): Promise<ExitCode> {
  if (ctx.options.yes !== true && !process.stdin.isTTY) {
    process.stderr.write(
      'interactive_required: update download requires --yes in non-interactive mode\n',
    );
    return 3;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<UpdateDownloadResultDTO>('/v1/update/download', {});
    process.stdout.write(
      ctx.format === 'json' ? renderJson(body) + '\n' : renderDownloadResultText(body) + '\n',
    );
    return body.success ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runUpdateInstall(ctx: CliSubcommandContext): Promise<ExitCode> {
  if (ctx.options.yes !== true && !process.stdin.isTTY) {
    process.stderr.write(
      'interactive_required: update install requires --yes in non-interactive mode\n',
    );
    return 3;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<UpdateInstallResultDTO>('/v1/update/install', {});
    process.stdout.write(
      ctx.format === 'json' ? renderJson(body) + '\n' : renderInstallResultText(body) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}
