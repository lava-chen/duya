/**
 * packages/cli/src/commands/memory.ts
 *
 * `duya memory doctor`   — machine evaluation + current `[memory.rag]` config
 *                          + an embedding provider/model recommendation (read-only)
 * `duya memory status`   — config + index state (documents / embedding) (read-only)
 * `duya memory setup`    — enable `[memory.rag]` and set the embedding provider/model
 * `duya memory enable`   — turn memory RAG on (`memory.rag.enabled = true`)
 * `duya memory disable`  — turn memory RAG off (`memory.rag.enabled = false`)
 * `duya memory set`      — write a single `memory.rag.<path>` value
 *
 * Thin wrappers over the `/v1/memory/*` routes (plan 431). The write ops
 * require `--yes` in non-interactive mode, matching the Phase 7 contract.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext } from '../program/registry.js';
import type { ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTOs — mirror electron/cli/handlers/memory.ts
// ---------------------------------------------------------------------------

interface MachineInfo {
  cpuCores: number;
  ramGb: number;
  ramTier: 'low' | 'mid' | 'high';
  diskFreeGb: number;
  lowPower: boolean;
}

interface Recommendation {
  provider: string;
  model: string;
  rationale: string;
}

interface MemoryDoctorResponse {
  ok: boolean;
  machine: MachineInfo;
  current: {
    enabled: boolean;
    embeddingProvider: string;
    embeddingModel: string;
    scanPaths: string[];
    indexExists: boolean;
  };
  recommendation: Recommendation;
}

interface MemorySetupResponse {
  ok: boolean;
  enabled: boolean;
  provider: string;
  model: string;
}

interface MemoryStatusResponse {
  ok: boolean;
  enabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  indexPath: string;
  scanPaths: string[];
  indexExists: boolean;
  documents: number;
  embeddingActive: boolean;
}

interface MemoryConfigResponse {
  ok: boolean;
  path: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function machineRamTierLabel(tier: MachineInfo['ramTier']): string {
  return tier === 'low' ? 'low' : tier === 'mid' ? 'mid' : 'high';
}

function renderDoctorText(body: MemoryDoctorResponse): string {
  const m = body.machine;
  const c = body.current;
  const r = body.recommendation;
  const lines = [
    `machine:`,
    `  cpu:          ${m.cpuCores} cores`,
    `  ram:          ${m.ramGb.toFixed(1)} GiB (${machineRamTierLabel(m.ramTier)} tier)`,
    `  disk free:    ${m.diskFreeGb < 0 ? 'unknown' : `${m.diskFreeGb.toFixed(1)} GiB`}`,
    `  low power:    ${m.lowPower ? 'yes' : 'no'}`,
    `memory rag:`,
    `  enabled:      ${c.enabled ? 'yes' : 'no'}`,
    `  embedding:    ${c.embeddingProvider}${c.embeddingModel ? ` / ${c.embeddingModel}` : ''}`,
    `  index exists: ${c.indexExists ? 'yes' : 'no'}`,
    `recommended:`,
    `  provider:     ${r.provider}`,
    `  model:        ${r.model || '(auto)'}`,
    `  rationale:    ${r.rationale}`,
  ];
  return lines.join('\n');
}

function renderStatusText(body: MemoryStatusResponse): string {
  const lines = [
    `enabled:    ${body.enabled ? 'yes' : 'no'}`,
    `embedding:  ${body.embeddingProvider}${body.embeddingModel ? ` / ${body.embeddingModel}` : ''}`,
    `index path: ${body.indexPath}`,
    `index:      ${body.indexExists ? `${body.documents} documents` : 'not built'}`,
    `embedding active: ${body.embeddingActive ? 'yes' : 'no'}`,
  ];
  if (body.scanPaths.length > 0) {
    lines.push(`scan paths: ${body.scanPaths.join(', ')}`);
  }
  return lines.join('\n');
}

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return err.isAppUnavailable() ? 2 : 1;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

function requireYes(ctx: CliSubcommandContext): boolean {
  if (ctx.options.yes === true) return true;
  if (process.stdin.isTTY) return true;
  process.stderr.write('interactive_required: write operation requires --yes in non-interactive mode\n');
  return false;
}

// ---------------------------------------------------------------------------
// `duya memory doctor`
// ---------------------------------------------------------------------------

export async function runMemoryDoctor(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<MemoryDoctorResponse>('/v1/memory/doctor');
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderDoctorText(body) + '\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// ---------------------------------------------------------------------------
// `duya memory status`
// ---------------------------------------------------------------------------

export async function runMemoryStatus(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<MemoryStatusResponse>('/v1/memory/status');
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderStatusText(body) + '\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// ---------------------------------------------------------------------------
// `duya memory setup`
// ---------------------------------------------------------------------------

export async function runMemorySetup(ctx: CliSubcommandContext): Promise<ExitCode> {
  if (!requireYes(ctx)) return 3;
  const o = ctx.options;
  const body: Record<string, unknown> = {};
  if (o.memoryAuto === true) {
    body.auto = true;
  } else if (typeof o.memoryProvider === 'string') {
    body.provider = o.memoryProvider;
    body.model = typeof o.memoryModel === 'string' && o.memoryModel ? o.memoryModel : '';
  } else {
    process.stderr.write('memory setup — provide --auto or --provider [--model]\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<MemorySetupResponse>('/v1/memory/setup', body);
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else {
      process.stdout.write(
        `memory rag enabled: provider=${result.provider}${result.model ? ` model=${result.model}` : ''}\n`,
      );
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// ---------------------------------------------------------------------------
// `duya memory enable` / `duya memory disable` / `duya memory set`
// ---------------------------------------------------------------------------

async function writeMemoryConfig(
  ctx: CliSubcommandContext,
  path: string,
  value: unknown,
): Promise<ExitCode> {
  if (!requireYes(ctx)) return 3;
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<MemoryConfigResponse>('/v1/memory/config', { path, value });
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else {
      process.stdout.write(`memory.rag.${result.path} = ${JSON.stringify(result.value)}\n`);
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

function coerceValue(raw: string): boolean | string {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

export async function runMemoryEnable(ctx: CliSubcommandContext): Promise<ExitCode> {
  return writeMemoryConfig(ctx, 'enabled', true);
}

export async function runMemoryDisable(ctx: CliSubcommandContext): Promise<ExitCode> {
  return writeMemoryConfig(ctx, 'enabled', false);
}

export async function runMemorySet(ctx: CliSubcommandContext): Promise<ExitCode> {
  const path = ctx.args[0];
  const valueRaw = ctx.args[1];
  if (!path || valueRaw === undefined) {
    process.stderr.write('memory set <path> <value> — path and value are required (e.g. `enabled true`, `embedding_model bge-m3`)\n');
    return 64;
  }
  return writeMemoryConfig(ctx, path, coerceValue(valueRaw));
}