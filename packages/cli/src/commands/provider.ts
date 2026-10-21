/**
 * packages/agent/src/cli/commands/provider.ts
 *
 * `duya provider list` / `duya provider info <id>` read-only commands.
 *
 * Reads the LLM provider list from the main process via
 * /v1/providers. The main process owns the config and DTO.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';

interface ProviderListItemDTO {
  id: string;
  name: string;
  providerType: string;
  isActive: boolean;
  hasKey: boolean;
  model?: string;
  baseUrl?: string;
  notes?: string;
  sortOrder?: number;
}

interface ProviderInfoItemDTO extends ProviderListItemDTO {
  headers: Record<string, string>;
  extraEnvKeys: string[];
}

function renderListText(providers: ProviderListItemDTO[]): string {
  if (providers.length === 0) return '(no providers configured)';
  const lines: string[] = [];
  lines.push(`${providers.length} provider${providers.length !== 1 ? 's' : ''} configured`);
  for (const p of providers) {
    const active = p.isActive ? ' [active]' : '';
    const key = p.hasKey ? 'key:yes' : 'key:no';
    const model = p.model ? ` model=${p.model}` : '';
    lines.push(`  ${p.id.padEnd(28)} ${p.providerType.padEnd(16)} ${key}${active}${model}`);
  }
  return lines.join('\n');
}

function renderInfoText(p: ProviderInfoItemDTO): string {
  const lines: string[] = [];
  lines.push(`${p.id}`);
  lines.push(`  name:        ${p.name}`);
  lines.push(`  type:        ${p.providerType}`);
  lines.push(`  isActive:    ${p.isActive ? 'yes' : 'no'}`);
  lines.push(`  hasKey:      ${p.hasKey ? 'yes' : 'no'}`);
  if (p.baseUrl) lines.push(`  baseUrl:     ${p.baseUrl}`);
  if (p.model) lines.push(`  model:       ${p.model}`);
  if (p.notes) lines.push(`  notes:       ${p.notes}`);
  if (p.headers && Object.keys(p.headers).length > 0) {
    lines.push(`  headers:     ${Object.keys(p.headers).join(', ')}`);
  }
  if (p.extraEnvKeys && p.extraEnvKeys.length > 0) {
    lines.push(`  extraEnv:    ${p.extraEnvKeys.join(', ')}`);
  }
  return lines.join('\n');
}

async function fetchProviders(): Promise<ProviderListItemDTO[]> {
  const client = await CliApiClient.connect();
  const body = await client.get<{ providers: ProviderListItemDTO[] }>('/v1/providers');
  return body.providers;
}

async function fetchProviderInfo(id: string): Promise<ProviderInfoItemDTO> {
  const client = await CliApiClient.connect();
  const body = await client.get<{ provider: ProviderInfoItemDTO }>(`/v1/providers/${encodeURIComponent(id)}`);
  return body.provider;
}

export async function runProviderListCommand(format: OutputFormat): Promise<number> {
  try {
    const providers = await fetchProviders();
    if (format === 'json') {
      process.stdout.write(renderJson({ providers }) + '\n');
    } else {
      process.stdout.write(renderListText(providers) + '\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}

export async function runProviderInfoCommand(id: string, format: OutputFormat): Promise<number> {
  try {
    const info = await fetchProviderInfo(id);
    if (format === 'json') {
      process.stdout.write(renderJson({ provider: info }) + '\n');
    } else {
      process.stdout.write(renderInfoText(info) + '\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}