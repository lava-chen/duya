/**
 * packages/cli/src/commands/projects-cleanup.ts
 *
 * `duya projects cleanup` — scan ~/.duya/projects/ for empty project
 * directories and the historical `duya` orphan (left over from the
 * pre-UUID `project_name='duya'` naming), report findings, and
 * optionally delete or archive them.
 *
 * Plan 536 §2.5.
 *
 * Safety:
 *   - Default mode is `--dry-run` (no writes; just prints the report).
 *   - Non-UUID names (e.g. `duya`) are NEVER auto-deleted; only suggested
 *     for archive via `--archive-dir`.
 *   - `--apply` is required to perform deletions.
 *   - `--yes` is required in non-TTY mode for `--apply`.
 *
 * Exit codes:
 *   0  — scan completed (whether or not anything was deleted)
 *   1  — generic error (filesystem, JSON parse, etc.)
 *   2  — duya app unavailable (not applicable here; this is a pure CLI fs op)
 *   3  — interactive required (write op without --yes in non-TTY)
 *   64 — usage error
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';
import { renderJson, type OutputFormat } from '../api/format.js';

const ok = (n: number): ExitCode => n as ExitCode;

export interface ProjectDirReport {
  /** Directory name (basename of the path under projects/) */
  name: string;
  /** Absolute path */
  path: string;
  /** True if directory matches UUID v1-5 shape. False for legacy non-UUID names. */
  isUuid: boolean;
  /** True if directory contains no real content (no plans/*.md and no non-template AGENTS.md). */
  isEmpty: boolean;
  /** Listing of contents at scan time (so deletions are traceable post-hoc). */
  contents: string[];
  /** Suggested action based on heuristics. */
  suggestedAction: 'delete' | 'archive' | 'keep';
  /** Note explaining the suggestion (especially for non-UUID legacy names). */
  note?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveProjectsRoot(): string {
  return path.join(os.homedir(), '.duya', 'projects');
}

/**
 * Plan 536 §2.5 — allow tests to point the cleanup scanner at an isolated
 * fixture directory via `DUYA_PROJECTS_ROOT`. Production code never sets
 * this; it is purely a test seam. The real `~/.duya/projects/` is the
 * default.
 */
function resolveProjectsRootWithEnv(): string {
  const fromEnv = process.env.DUYA_PROJECTS_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return resolveProjectsRoot();
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function hasNonTemplateAgentsMd(dir: string): boolean {
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) return false;
  try {
    const text = fs.readFileSync(agentsPath, 'utf8');
    // Template content from the auto-seed contains:
    // "_Describe the project: goal, scope, audience, success criteria._"
    // If that line is present, the file has not been edited by the user.
    return !text.includes('_Describe the project:');
  } catch {
    return false;
  }
}

function hasAnyPlanFile(dir: string): boolean {
  const plansDir = path.join(dir, 'plans');
  if (!fs.existsSync(plansDir) || !fs.statSync(plansDir).isDirectory()) {
    return false;
  }
  const entries = listDirSafe(plansDir);
  return entries.some((name) => name.endsWith('.md'));
}

function isProjectDirEmpty(dir: string): boolean {
  if (hasAnyPlanFile(dir)) return false;
  if (hasNonTemplateAgentsMd(dir)) return false;
  // If there is any *other* file or directory, treat as non-empty.
  const others = listDirSafe(dir).filter((name) => name !== 'AGENTS.md' && name !== 'plans');
  if (others.length > 0) return false;
  // Empty plans/ + default-template AGENTS.md → empty.
  // Empty plans/ only (no AGENTS.md) → empty.
  // Both missing → empty.
  return true;
}

function classifyProjectDir(name: string, abs: string): ProjectDirReport {
  const isUuid = UUID_RE.test(name);
  const isEmpty = isProjectDirEmpty(abs);
  const contents = listDirSafe(abs);
  let suggestedAction: ProjectDirReport['suggestedAction'] = 'keep';
  let note: string | undefined;
  if (!isUuid) {
    suggestedAction = 'archive';
    note = 'Non-UUID directory name (likely legacy `project_name` artifact). Auto-deletion disabled; archive with `--archive-dir` to preserve.';
  } else if (isEmpty) {
    suggestedAction = 'delete';
    note = 'Empty: no plans, only template AGENTS.md (or none). Safe to delete.';
  } else {
    suggestedAction = 'keep';
    note = 'Has plans or user-edited AGENTS.md. Skip.';
  }
  return { name, path: abs, isUuid, isEmpty, contents, suggestedAction, note };
}

export interface CleanupReport {
  scannedAt: string;
  projectsRoot: string;
  scanned: number;
  emptyUuids: string[];
  nonUuidNames: string[];
  keptNonEmptyUuids: string[];
  /** Per-directory classification details. */
  entries: ProjectDirReport[];
  /** Actions taken (only when --apply). */
  applied?: {
    deleted: string[];
    archived: string[];
    errors: Array<{ path: string; error: string }>;
  };
}

export function scanProjects(opts: { projectsRoot?: string } = {}): CleanupReport {
  const projectsRoot = opts.projectsRoot ?? resolveProjectsRootWithEnv();
  const entries = listDirSafe(projectsRoot)
    .filter((name) => {
      const abs = path.join(projectsRoot, name);
      try {
        return fs.statSync(abs).isDirectory();
      } catch {
        return false;
      }
    })
    .map((name) => classifyProjectDir(name, path.join(projectsRoot, name)));

  const emptyUuids = entries.filter((e) => e.isUuid && e.suggestedAction === 'delete').map((e) => e.name);
  const nonUuidNames = entries.filter((e) => !e.isUuid).map((e) => e.name);
  const keptNonEmptyUuids = entries.filter((e) => e.isUuid && e.suggestedAction === 'keep').map((e) => e.name);

  return {
    scannedAt: new Date().toISOString(),
    projectsRoot,
    scanned: entries.length,
    emptyUuids,
    nonUuidNames,
    keptNonEmptyUuids,
    entries,
  };
}

function renderText(report: CleanupReport, mode: 'dry-run' | 'applied'): string {
  const lines: string[] = [];
  lines.push(`Projects cleanup — ${report.scannedAt}`);
  lines.push(`  root:        ${report.projectsRoot}`);
  lines.push(`  scanned:     ${report.scanned}`);
  lines.push(`  empty (UUID, safe to delete): ${report.emptyUuids.length}`);
  lines.push(`  non-UUID (legacy names):      ${report.nonUuidNames.length}`);
  lines.push(`  non-empty (keep):             ${report.keptNonEmptyUuids.length}`);
  lines.push('');

  if (report.emptyUuids.length > 0) {
    lines.push('Empty UUID directories:');
    for (const e of report.entries.filter((e) => e.suggestedAction === 'delete')) {
      lines.push(`  ${e.name}  (${e.contents.length} entries: ${e.contents.join(', ') || '∅'})`);
    }
    lines.push('');
  }

  if (report.nonUuidNames.length > 0) {
    lines.push('Non-UUID (legacy) names — NEVER auto-deleted:');
    for (const e of report.entries.filter((e) => !e.isUuid)) {
      lines.push(`  ${e.name}  (contents: ${e.contents.join(', ') || '∅'})`);
      lines.push(`    note: ${e.note ?? ''}`);
    }
    lines.push('');
  }

  if (report.keptNonEmptyUuids.length > 0) {
    lines.push('Kept (non-empty UUID):');
    for (const name of report.keptNonEmptyUuids) {
      lines.push(`  ${name}`);
    }
    lines.push('');
  }

  if (mode === 'applied' && report.applied) {
    lines.push('Applied:');
    lines.push(`  deleted: ${report.applied.deleted.length}`);
    for (const p of report.applied.deleted) lines.push(`    - ${p}`);
    lines.push(`  archived: ${report.applied.archived.length}`);
    for (const p of report.applied.archived) lines.push(`    - ${p}`);
    if (report.applied.errors.length > 0) {
      lines.push(`  errors: ${report.applied.errors.length}`);
      for (const err of report.applied.errors) lines.push(`    - ${err.path}: ${err.error}`);
    }
  } else {
    lines.push('Mode: dry-run. Re-run with `--apply --yes` to delete empty UUID directories; pass `--archive-dir <path>` to also archive legacy non-UUID names.');
  }
  return lines.join('\n');
}

export async function runProjectsCleanupCommand(ctx: CliSubcommandContext): Promise<ExitCode> {
  const format: OutputFormat = ctx.format;
  const apply = ctx.options.apply === true;
  const yes = ctx.options.yes === true;
  const archiveDir = typeof ctx.options.archiveDir === 'string' ? ctx.options.archiveDir : undefined;

  // Refuse to apply without explicit confirmation in non-TTY mode.
  if (apply && !yes && !process.stdin.isTTY) {
    process.stderr.write(
      'Refusing to apply changes in non-interactive mode without `--yes`. ' +
        'Re-run with `--apply --yes` (or in an interactive shell).\n',
    );
    return ok(3);
  }

  let report: CleanupReport;
  try {
    report = scanProjects();
  } catch (err) {
    process.stderr.write(`scan failed: ${String(err)}\n`);
    return ok(1);
  }

  if (!apply) {
    if (format === 'json') {
      process.stdout.write(renderJson(report) + '\n');
    } else {
      process.stdout.write(renderText(report, 'dry-run') + '\n');
    }
    return ok(0);
  }

  // Apply: delete empty UUIDs, archive non-UUID names (only if archiveDir given).
  const deleted: string[] = [];
  const archived: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const entry of report.entries) {
    if (entry.suggestedAction === 'delete') {
      try {
        fs.rmSync(entry.path, { recursive: true, force: true });
        deleted.push(entry.path);
      } catch (err) {
        errors.push({ path: entry.path, error: String(err) });
      }
    } else if (entry.suggestedAction === 'archive') {
      if (!archiveDir) {
        // No archive destination — skip silently; user opted out by not passing --archive-dir.
        continue;
      }
      const target = path.join(archiveDir, `${entry.name}-${Date.now()}`);
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.cpSync(entry.path, target, { recursive: true });
        // Move semantics: keep a copy in archive, leave original alone (deletion is separate).
        archived.push(target);
      } catch (err) {
        errors.push({ path: entry.path, error: String(err) });
      }
    }
  }

  report.applied = { deleted, archived, errors };

  if (format === 'json') {
    process.stdout.write(renderJson(report) + '\n');
  } else {
    process.stdout.write(renderText(report, 'applied') + '\n');
  }

  // Non-zero exit if there were any errors during apply.
  return errors.length > 0 ? ok(1) : ok(0);
}