#!/usr/bin/env node
/**
 * One-off migration CLI: project_path_aliases → projects.paths JSON
 * (Plan 525 Phase 2). Dry-run by default; `--apply` writes and drops
 * the alias table. Review the dry-run report before applying.
 *
 * Usage:
 *   node scripts/migrate-projects-paths.ts --db <path/to/memory-state.db>
 *   node scripts/migrate-projects-paths.ts --db <path/to/memory-state.db> --apply
 *
 * Uses node:sqlite (no native binding / ABI concerns). WAL allows
 * running against a live DB, but close the app for a clean apply.
 */
import { DatabaseSync } from 'node:sqlite';
import { applyPathsMigration, dryRunPathsMigration } from '../electron/memory-state/pathsMigration.ts';

function parseArgs(argv: string[]): { db?: string; apply: boolean } {
  const args: { db?: string; apply: boolean } = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      args.db = argv[++i];
    } else if (argv[i] === '--apply') {
      args.apply = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) {
  console.error('Usage: node scripts/migrate-projects-paths.ts --db <memory-state.db> [--apply]');
  process.exit(1);
}

const db = new DatabaseSync(args.db);
db.exec('PRAGMA busy_timeout = 5000');

const report = dryRunPathsMigration(db);

console.log('=== Plan 525 Phase 2 — project_path_aliases → projects.paths ===');
console.log(`db:              ${args.db}`);
console.log(`alias table:     ${report.alias_table_exists ? 'present' : 'MISSING (already migrated?)'}`);
console.log(`alias rows:      ${report.total_alias_rows}`);
console.log(`merged paths:    ${report.total_merged_paths}`);
console.log(`orphan projects: ${report.orphan_project_ids.length ? report.orphan_project_ids.join(', ') : 'none'}`);
console.log('');
for (const p of report.projects) {
  const flag = p.project_row_exists ? '' : '  [ORPHAN — no projects row]';
  console.log(
    `project ${p.project_id}  root=${p.canonical_root ?? '-'}  ` +
      `aliasRows=${p.alias_row_count}→mergedPaths=${p.merged_path_count}  ` +
      `existingPaths=${p.existing_path_count}${flag}`
  );
}
console.log('');

if (!args.apply) {
  console.log('DRY RUN — no changes written. Re-run with --apply to migrate and drop the table.');
  process.exit(0);
}

if (!report.alias_table_exists) {
  console.error('Nothing to apply: project_path_aliases does not exist.');
  process.exit(1);
}
if (report.orphan_project_ids.length > 0) {
  console.error('Orphan alias rows found — fix them manually before applying.');
  process.exit(1);
}

const result = applyPathsMigration(db);
console.log(`APPLIED — updated ${result.updated_projects} project(s), dropped project_path_aliases.`);
console.log('Re-run without --apply to verify the report is now empty.');
