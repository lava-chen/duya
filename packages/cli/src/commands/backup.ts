/**
 * packages/cli/src/commands/backup.ts
 *
 * `duya backup` — local state archive control plane.
 *
 * Subcommands:
 *   plan    — preview the paths that would be included (no writes)
 *   create  — write a new .tar.gz archive (Phase 7 write op)
 *   verify  — verify an existing archive
 *   restore — restore from an archive (Phase 2: dry-run only; the
 *             live swap ships in Plan 200 R2)
 *
 * Data source: `electron/cli/handlers/backup.ts` →
 *   POST /v1/backup/plan
 *   POST /v1/backup/create
 *   POST /v1/backup/verify
 *   POST /v1/backup/restore
 *
 * Exit codes:
 *   0  — success
 *   1  — generic / upstream error
 *   2  — app unavailable
 *   3  — interactive required (write op without --yes in non-TTY)
 *   64 — usage error
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTO mirrors
// ---------------------------------------------------------------------------

export interface BackupSourceDTO {
  label: string;
  archivePath: string;
  absolutePath: string;
  sizeBytes: number | null;
  exists: boolean;
}

export interface BackupPlanDTO {
  outputPath: string;
  sources: BackupSourceDTO[];
}

export interface BackupManifestDTO {
  version: 1;
  createdAt: number;
  appVersion: string;
  sources: Array<{
    label: string;
    archivePath: string;
    absolutePath: string;
    sizeBytes: number | null;
    existedAtCreate: boolean;
  }>;
  onlyConfig: boolean;
}

export interface BackupCreateResultDTO {
  ok: true;
  outputPath: string;
  archiveSizeBytes: number;
  manifest: BackupManifestDTO;
  verified: boolean;
}

export interface BackupVerifyResultDTO {
  ok: true;
  manifest: BackupManifestDTO;
  payloadFileCount: number;
  totalPayloadBytes: number;
}

export interface BackupRestorePlanDTO {
  ok: true;
  archivePath: string;
  manifest: BackupManifestDTO;
  stagingDir: string;
  filesToRestore: number;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}G`;
}

function renderPlanText(p: BackupPlanDTO): string {
  const lines: string[] = [];
  lines.push('Backup plan:');
  lines.push(`  output: ${p.outputPath}`);
  for (const s of p.sources) {
    const size = s.sizeBytes !== null ? formatBytes(s.sizeBytes) : 'missing';
    const tag = s.exists ? size : '(missing)';
    lines.push(`  - ${s.label.padEnd(12)} ${s.absolutePath}  [${tag}]`);
  }
  return lines.join('\n');
}

function renderCreateResultText(r: BackupCreateResultDTO): string {
  const lines: string[] = [];
  lines.push(`Backup written: ${r.outputPath} (${formatBytes(r.archiveSizeBytes)})`);
  if (r.verified) lines.push('  verify: ok');
  return lines.join('\n');
}

function renderVerifyResultText(r: BackupVerifyResultDTO): string {
  return `Archive ok. ${r.payloadFileCount} payload file(s), ${formatBytes(r.totalPayloadBytes)} total.`;
}

function renderRestorePlanText(p: BackupRestorePlanDTO): string {
  return [
    `Restore plan (dry-run):`,
    `  archive:    ${p.archivePath}`,
    `  stagingDir: ${p.stagingDir}`,
    `  files:      ${p.filesToRestore}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

function requireYes(ctx: CliSubcommandContext, action: string): ExitCode | null {
  if (ctx.options.yes === true || process.stdin.isTTY) return null;
  process.stderr.write(
    `interactive_required: ${action} requires --yes in non-interactive mode\n`,
  );
  return 3;
}

function output(format: OutputFormat, json: unknown, text: string): void {
  process.stdout.write(format === 'json' ? renderJson(json) + '\n' : text + '\n');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export async function runBackupPlan(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<BackupPlanDTO>('/v1/backup/plan', {});
    output(ctx.format, body, renderPlanText(body));
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function runBackupCreate(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = requireYes(ctx, 'backup create');
  if (guard !== null) return guard;

  const body = {
    outputDir: typeof ctx.options.outputDir === 'string' ? ctx.options.outputDir : undefined,
    includeWorkspace: ctx.options.includeWorkspace === true,
    onlyConfig: ctx.options.onlyConfig === true,
    dryRun: ctx.options.dryRun === true,
    verify: ctx.options.verify === true,
  };
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<BackupCreateResultDTO>('/v1/backup/create', body);
    output(ctx.format, result, renderCreateResultText(result));
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function runBackupVerify(ctx: CliSubcommandContext): Promise<ExitCode> {
  const archivePath = ctx.args[0];
  if (!archivePath) {
    process.stderr.write('usage: duya backup verify <archive.tar.gz>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<BackupVerifyResultDTO>('/v1/backup/verify', {
      archivePath,
    });
    output(ctx.format, result, renderVerifyResultText(result));
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function runBackupRestore(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = requireYes(ctx, 'backup restore');
  if (guard !== null) return guard;

  const archivePath = ctx.args[0];
  if (!archivePath) {
    process.stderr.write('usage: duya backup restore <archive.tar.gz> [--dry-run]\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<BackupRestorePlanDTO>('/v1/backup/restore', {
      archivePath,
      dryRun: ctx.options.dryRun === true,
    });
    output(ctx.format, result, renderRestorePlanText(result));
    return 0;
  } catch (err) {
    return reportError(err);
  }
}
