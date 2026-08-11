/**
 * packages/cli/src/commands/voice.ts
 *
 * `duya voice doctor` / `duya voice setup` / `duya voice enable` /
 * `duya voice disable` / `duya voice set` — whisper environment
 * diagnostics, first-use configuration guidance, and `[voice]` config writes.
 *
 * Data source: `electron/cli/handlers/voice.ts` →
 *   GET  /v1/voice/env
 *   POST /v1/voice/setup
 *   POST /v1/voice/config
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

export interface VoiceConfigDTO {
  ok: boolean;
  path?: string;
  value?: unknown;
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

// ---------------------------------------------------------------------------
// Config write commands (`duya voice enable` / `disable` / `set`)
// ---------------------------------------------------------------------------

/** Write a value under the `[voice]` config section via the CLI API. */
async function writeVoiceConfig(path: string, value: unknown, format: OutputFormat): Promise<number> {
  try {
    if (!path) {
      process.stderr.write('path argument required (e.g. stt.engine)\n');
      return 64;
    }
    const client = await CliApiClient.connect();
    const body = await client.post<VoiceConfigDTO>('/v1/voice/config', { path, value });
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`voice.${body.path ?? path} = ${JSON.stringify(body.value ?? value)}\n`);
    }
    return body.ok === true ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runVoiceEnableCommand(format: OutputFormat): Promise<number> {
  return writeVoiceConfig('enabled', true, format);
}

export async function runVoiceDisableCommand(format: OutputFormat): Promise<number> {
  return writeVoiceConfig('enabled', false, format);
}

export async function runVoiceSetCommand(
  format: OutputFormat,
  path: string,
  value: string,
): Promise<number> {
  return writeVoiceConfig(path, value, format);
}