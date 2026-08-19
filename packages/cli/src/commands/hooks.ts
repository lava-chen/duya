/**
 * packages/cli/src/commands/hooks.ts
 *
 * `duya hook list` / `duya hook validate` / `duya hook add` /
 * `duya hook remove` — manage the `[hooks] files` array of
 * `~/.duya/config.toml` through the desktop app's CLI API.
 *
 * The config only records hook.json paths; hook content lives in the JSON
 * files (ecosystem shape shared with Claude Code / ZCode). `add` validates
 * the file before writing, so a broken hook.json can never land in the
 * config.
 *
 * Data source: `electron/cli/handlers/hooks.ts` →
 *   GET  /v1/hooks/list
 *   POST /v1/hooks/validate
 *   POST /v1/hooks/add
 *   POST /v1/hooks/remove
 *
 * Exit codes:
 *   0 — ok
 *   1 — error (invalid file, app unavailable, etc.)
 *   2 — app unavailable (open DUYA and retry)
 *   3 — interactive confirmation required (write ops without --yes)
 *   64 — usage error
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import { stdin } from 'process';

// ---------------------------------------------------------------------------
// DTO mirrors
// ---------------------------------------------------------------------------

export interface HookFileStatusDTO {
  path: string;
  resolved: string;
  ok: boolean;
  error?: string;
  events?: string[];
  hookCount?: number;
}

export interface HookListDTO {
  ok: boolean;
  configPath?: string;
  files?: HookFileStatusDTO[];
  error?: string;
}

export interface HookWriteDTO {
  ok: boolean;
  already?: boolean;
  removed?: boolean;
  added?: string;
  files?: string[];
  error?: string;
  path?: string;
  resolved?: string;
  events?: string[];
  hookCount?: number;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

function renderListText(r: HookListDTO): string {
  const lines = [
    'Configured hooks',
    '===============',
    `Config: ${r.configPath ?? ''}`,
    '',
  ];
  const files = r.files ?? [];
  if (files.length === 0) {
    lines.push('No hook.json files registered under [hooks] files.');
    lines.push('Add one with: duya hook add <path-to-hook.json>');
    return lines.join('\n');
  }
  for (const f of files) {
    const status = f.ok
      ? `ok (${f.hookCount ?? 0} hooks: ${(f.events ?? []).join(', ') || '-'})`
      : `ERROR: ${f.error ?? 'unreadable'}`;
    lines.push(`  ${f.path}`);
    lines.push(`    → ${f.resolved}`);
    lines.push(`    ${status}`);
  }
  return lines.join('\n');
}

function renderValidateText(r: HookWriteDTO): string {
  if (r.ok !== true) {
    return `Invalid hook file: ${r.error ?? 'unknown error'}`;
  }
  const events = (r.events ?? []).join(', ') || '-';
  return `Valid: ${r.resolved ?? ''}\n  ${r.hookCount ?? 0} hooks on events: ${events}`;
}

function renderWriteText(r: HookWriteDTO, verb: string): string {
  if (r.ok !== true) {
    return `${verb} failed: ${r.error ?? 'unknown error'}`;
  }
  const lines = [r.already === true ? `Already registered: ${r.added}` : `${verb}: ${r.added ?? ''}`];
  lines.push(`[hooks] files (${(r.files ?? []).length}):`);
  for (const f of r.files ?? []) lines.push(`  ${f}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportError(err: unknown): number {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return err.isAppUnavailable() ? 2 : 1;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

/** Write-op gate: `--yes` required in non-interactive mode (mirrors plugin.ts). */
function requireYes(yes: boolean, action: string): boolean {
  if (yes) return true;
  if (!stdin.isTTY) {
    process.stderr.write(
      `interactive_required: ${action} requires --yes in non-interactive mode\n`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export async function runHookListCommand(format: OutputFormat): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<HookListDTO>('/v1/hooks/list');
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderListText(body) + '\n');
    }
    return body.ok === true ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runHookValidateCommand(format: OutputFormat, rawPath: string): Promise<number> {
  if (!rawPath) {
    process.stderr.write('path argument required (path to hook.json)\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<HookWriteDTO>('/v1/hooks/validate', { path: rawPath });
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderValidateText(body) + '\n');
    }
    return body.ok === true ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runHookAddCommand(format: OutputFormat, rawPath: string, yes: boolean): Promise<number> {
  if (!rawPath) {
    process.stderr.write('path argument required (path to hook.json)\n');
    return 64;
  }
  if (!requireYes(yes, 'duya hook add')) return 3;
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<HookWriteDTO>('/v1/hooks/add', { path: rawPath });
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderWriteText(body, 'Registered') + '\n');
    }
    return body.ok === true ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runHookRemoveCommand(format: OutputFormat, rawPath: string, yes: boolean): Promise<number> {
  if (!rawPath) {
    process.stderr.write('path argument required (path to hook.json)\n');
    return 64;
  }
  if (!requireYes(yes, 'duya hook remove')) return 3;
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<HookWriteDTO>('/v1/hooks/remove', { path: rawPath });
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(
        body.removed === true
          ? renderWriteText(body, 'Removed')
          : `Not registered (no change): ${rawPath}\n`,
      );
    }
    return body.ok === true ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}
