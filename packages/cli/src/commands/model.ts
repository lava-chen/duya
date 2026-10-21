/**
 * packages/cli/src/commands/model.ts
 *
 * `duya model list` / `duya model current` / `duya model info <id>` —
 * read-only views of the LLM models currently configured.
 *
 * Mirrors mcode's provider+model unified command: each provider owns one
 * default model today, so the model view is a projection of the provider
 * list. Write operations (set default) live in `duya config provider
 * set-default` — this command is intentionally read-only.
 *
 * Reads from the running Desktop via /v1/providers and /v1/providers/active.
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

interface ActiveProviderResponse {
  provider: ProviderInfoItemDTO | null;
}

function renderListText(providers: readonly ProviderListItemDTO[]): string {
  if (providers.length === 0) return '(no models configured — add a provider first)';
  const lines: string[] = [];
  lines.push(`${providers.length} model${providers.length !== 1 ? 's' : ''} configured`);
  for (const p of providers) {
    const marker = p.isActive ? '*' : ' ';
    const key = p.hasKey ? 'key:yes' : 'key:no';
    const model = p.model ?? '(no model)';
    lines.push(`  ${marker} ${p.id.padEnd(28)} ${model.padEnd(36)} ${p.providerType.padEnd(16)} ${key}`);
  }
  return lines.join('\n');
}

function renderCurrentText(provider: ProviderInfoItemDTO | null): string {
  if (provider === null) return '(no active provider — set one with `duya config provider set-default <id>`)';
  const lines: string[] = [];
  lines.push(`active provider: ${provider.id}`);
  lines.push(`  model:    ${provider.model ?? '(none)'}`);
  lines.push(`  type:     ${provider.providerType}`);
  lines.push(`  baseUrl:  ${provider.baseUrl ?? '(default)'}`);
  lines.push(`  hasKey:   ${provider.hasKey ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function renderInfoText(p: ProviderInfoItemDTO): string {
  const lines: string[] = [];
  lines.push(`${p.id} — model: ${p.model ?? '(none)'}`);
  lines.push(`  name:        ${p.name}`);
  lines.push(`  type:        ${p.providerType}`);
  lines.push(`  isActive:    ${p.isActive ? 'yes' : 'no'}`);
  lines.push(`  hasKey:      ${p.hasKey ? 'yes' : 'no'}`);
  if (p.baseUrl) lines.push(`  baseUrl:     ${p.baseUrl}`);
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

async function fetchActiveProvider(): Promise<ProviderInfoItemDTO | null> {
  const client = await CliApiClient.connect();
  const body = await client.get<ActiveProviderResponse>('/v1/providers/active');
  return body.provider;
}

async function fetchProviderInfo(id: string): Promise<ProviderInfoItemDTO> {
  const client = await CliApiClient.connect();
  const body = await client.get<{ provider: ProviderInfoItemDTO }>(`/v1/providers/${encodeURIComponent(id)}`);
  return body.provider;
}

export async function runModelListCommand(format: OutputFormat): Promise<number> {
  try {
    const providers = await fetchProviders();
    if (format === 'json') {
      const models = providers.map((p) => ({
        providerId: p.id,
        providerName: p.name,
        providerType: p.providerType,
        isActive: p.isActive,
        hasKey: p.hasKey,
        model: p.model ?? null,
      }));
      process.stdout.write(renderJson({ models }) + '\n');
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

export async function runModelCurrentCommand(format: OutputFormat): Promise<number> {
  try {
    const provider = await fetchActiveProvider();
    if (format === 'json') {
      const payload = provider === null
        ? { active: null }
        : {
            active: {
              providerId: provider.id,
              providerName: provider.name,
              providerType: provider.providerType,
              model: provider.model ?? null,
              hasKey: provider.hasKey,
            },
          };
      process.stdout.write(renderJson(payload) + '\n');
    } else {
      process.stdout.write(renderCurrentText(provider) + '\n');
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

export async function runModelInfoCommand(id: string, format: OutputFormat): Promise<number> {
  try {
    const info = await fetchProviderInfo(id);
    if (format === 'json') {
      process.stdout.write(renderJson({ model: info }) + '\n');
    } else {
      process.stdout.write(renderInfoText(info) + '\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof CliApiError) {
      // 404 from /v1/providers/:id surfaces as CliApiError; show a model-flavored hint.
      process.stderr.write(`model not found for provider '${id}'\n`);
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}
