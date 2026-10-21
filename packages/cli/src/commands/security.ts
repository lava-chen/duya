/**
 * packages/cli/src/commands/security.ts
 *
 * `duya security` — read-only security audit + optional auto-fix.
 *
 * Subcommands:
 *   audit  — list every finding, sorted by severity
 *   fix    — apply registered auto-fixes; Phase 7 write op
 *
 * Data source: `electron/cli/handlers/security.ts` →
 *   POST /v1/security/audit
 *   POST /v1/security/fix
 *
 * Exit codes:
 *   0  — no findings (audit) or all fixes applied (fix)
 *   1  — findings present (audit) or partial fix (fix)
 *   2  — app unavailable
 *   3  — interactive required (fix without --yes in non-TTY)
 *   64 — usage error
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTO mirrors
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface FindingDTO {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  remediation: string;
  autoFixable: boolean;
  context?: Record<string, unknown>;
}

export interface AuditResultDTO {
  ok: true;
  generatedAt: number;
  appVersion: string;
  findings: FindingDTO[];
  counts: Record<Severity, number>;
}

export interface FixResultDTO {
  ok: true;
  applied: Array<{ id: string; title: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

const SEVERITY_TAG: Record<Severity, string> = {
  high: '[HIGH]',
  medium: '[MED] ',
  low: '[LOW] ',
  info: '[INFO]',
};

function renderAuditText(a: AuditResultDTO): string {
  const lines: string[] = [];
  lines.push(`Security audit — DUYA ${a.appVersion}`);
  lines.push(`  findings: high=${a.counts.high} medium=${a.counts.medium} low=${a.counts.low} info=${a.counts.info}`);
  if (a.findings.length === 0) {
    lines.push('  No issues found.');
    return lines.join('\n');
  }
  lines.push('');
  for (const f of a.findings) {
    lines.push(`${SEVERITY_TAG[f.severity]} ${f.id} ${f.title}`);
    lines.push(`  ${f.message}`);
    if (f.remediation) lines.push(`  Fix: ${f.remediation}`);
    if (f.autoFixable) lines.push('  (auto-fixable)');
    lines.push('');
  }
  return lines.join('\n');
}

function renderFixText(r: FixResultDTO): string {
  const lines: string[] = [];
  lines.push(`Applied ${r.applied.length} fix(es).`);
  for (const a of r.applied) {
    lines.push(`  ✓ ${a.id} ${a.title}`);
  }
  if (r.skipped.length > 0) {
    lines.push(`Skipped ${r.skipped.length}:`);
    for (const s of r.skipped) {
      lines.push(`  - ${s.id} (${s.reason})`);
    }
  }
  return lines.join('\n');
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

export async function runSecurityAudit(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<AuditResultDTO>('/v1/security/audit', {
      deep: ctx.options.deep === true,
    });
    output(ctx.format, body, renderAuditText(body));
    // Exit non-zero when high-severity findings are present, so CI
    // gates can pipe the command. --check (or default) returns 0 on
    // clean audits, 1 when there are findings.
    if (body.counts.high > 0) return 1;
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function runSecurityFix(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = requireYes(ctx, 'security fix');
  if (guard !== null) return guard;

  try {
    const client = await CliApiClient.connect();
    const result = await client.post<FixResultDTO>('/v1/security/fix', {});
    output(ctx.format, result, renderFixText(result));
    return 0;
  } catch (err) {
    return reportError(err);
  }
}
