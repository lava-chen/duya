/**
 * packages/agent/src/cli/api/format.ts
 *
 * Output format selection for CLI control plane commands.
 *
 *   text  — human-readable tables (default)
 *   json  — machine-readable JSON of the same payload
 *
 * Note: this is the CLI surface, NOT the HTTP API contract. The HTTP API
 * always returns JSON; the CLI layer here chooses how to render it.
 */

export type OutputFormat = 'text' | 'json';

export function parseFormat(value: string | undefined): OutputFormat {
  if (value === 'json' || value === 'text') return value;
  return 'text';
}

export function renderJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
