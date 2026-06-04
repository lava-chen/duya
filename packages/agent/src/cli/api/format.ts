/**
 * packages/agent/src/cli/api/format.ts
 *
 * Output format selection for CLI control plane commands.
 *
 *   text  — human-readable tables (default)
 *   json  — machine-readable JSON of the same payload
 *   tsv   — tab-separated, script-friendly (Plan 100, plugin list only)
 *
 * Note: this is the CLI surface, NOT the HTTP API contract. The HTTP API
 * always returns JSON; the CLI layer here chooses how to render it.
 */

export type OutputFormat = 'text' | 'json' | 'tsv';

export function parseFormat(value: string | undefined): OutputFormat {
  if (value === 'json' || value === 'text' || value === 'tsv') return value;
  return 'text';
}

export function renderJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
