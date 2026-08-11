/**
 * packages/cli/src/commands/voice.ts
 *
 * `duya voice doctor` / `duya voice setup` — whisper environment
 * diagnostics and first-use configuration guidance.
 *
 * Data source: `electron/cli/handlers/voice.ts` →
 *   GET  /v1/voice/env
 *   POST /v1/voice/setup
 *
 * Exit codes:
 *   0 — ok (binary found / model ready / setup succeeded)
 *   1 — error (binary missing, model download failed, etc.)
 *   2 — app unavailable (open DUYA and retry)
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';

// ---------------------------------------------------------------------------
// DTO mirrors
// ---------------------------------------------------------------------------

export interface VoiceEnvDTO {
  ok: boolean;
  platform: string;
  binaryFound: boolean;
  binaryPath?: string;
  model: string;
  modelReady: boolean;
  modelSizeMb: number;
  installSteps: string[];
  summary: string;
}

export interface VoiceSetupDTO {
  ok: boolean;
  model?: string;
  ready?: boolean;
  sizeMb?: number;
  binaryFound?: boolean;
  binaryPath?: string;
  installSteps?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

function renderDoctorText(r: VoiceEnvDTO): string {
  const lines = [
    'Whisper Environment — Read-Only Diagnostic Report',
    '==================================================',
    '',
    `Platform:       ${r.platform}`,
    `Whisper binary: ${r.binaryFound ? `found (${r.binaryPath})` : 'MISSING'}`,
    `Model:          ${r.model}${r.modelReady ? ` (ready, ${r.modelSizeMb} MB)` : ' (not downloaded yet)'}`,
    '',
  ];
  if (!r.binaryFound) {
    lines.push('Install steps:');
    for (const step of r.installSteps) lines.push(`  - ${step}`);
  }
  lines.push(`Summary: ${r.summary}`);
  return lines.join('\n');
}

function renderSetupText(r: VoiceSetupDTO): string {
  if (r.ok !== true) {
    return `Voice setup failed: ${r.error ?? 'unknown error'}`;
  }
  const lines = [
    'Voice setup complete',
    '====================',
    `Model:  ${r.model} (${r.sizeMb} MB, ready)`,
    `Binary: ${r.binaryFound ? `found (${r.binaryPath})` : 'MISSING'}`,
    '',
  ];
  if (!r.binaryFound) {
    lines.push('Install steps:');
    for (const step of r.installSteps ?? []) lines.push(`  - ${step}`);
  }
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

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export async function runVoiceDoctorCommand(format: OutputFormat): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<VoiceEnvDTO>('/v1/voice/env');
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderDoctorText(body) + '\n');
    }
    return body.ok === true ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runVoiceSetupCommand(format: OutputFormat): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<VoiceSetupDTO>('/v1/voice/setup', {});
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderSetupText(body) + '\n');
    }
    return body.ok === true ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}