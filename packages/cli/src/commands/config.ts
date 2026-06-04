/**
 * packages/cli/src/commands/config.ts
 *
 * `duya config …` — read and write DUYA desktop configuration.
 *
 * Plan 102: this command tree is the agent-facing (and terminal-facing)
 * surface for everything that used to live in `duya_config`. Each
 * subcommand is a thin wrapper around the existing main-process
 * /v1/config/* HTTP routes; the actual SQLite writes still go through
 * `electron/db/queries/configDb.ts` (via the IPC bridge in
 * `electron/agents/db-bridge.ts`).
 *
 * The `duya config provider` writes are audited in the main process
 * under `kind: 'config.provider.*'` (Plan 99 §5.2 audit contract).
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext } from '../program/registry.js';
import type { ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// Types — match the DTOs in electron/cli/handlers/config.ts
// ---------------------------------------------------------------------------

export interface ProviderDTO {
  id: string;
  name: string;
  providerType: string;
  baseUrl?: string;
  isActive: boolean;
  hasKey: boolean;
  model?: string;
}

export interface AgentSettingsDTO {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  enableThinking?: boolean;
  thinkingBudget?: number;
  mcpServers?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface VisionSettingsDTO {
  provider?: string;
  model?: string;
  baseUrl?: string;
  hasKey?: boolean;
  enabled?: boolean;
}

export interface OutputStyleEntry {
  id: string;
  name: string;
  description?: string;
}

export interface PairingEntry {
  platform: string;
  code?: string;
  platformUserId?: string;
  approvedAt?: number;
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderProvidersText(list: ProviderDTO[]): string {
  if (list.length === 0) return '(no providers configured)';
  const lines: string[] = [];
  lines.push(`${list.length} provider${list.length !== 1 ? 's' : ''} configured`);
  for (const p of list) {
    const active = p.isActive ? ' [active]' : '';
    const key = p.hasKey ? 'key:yes' : 'key:no';
    const model = p.model ? ` model=${p.model}` : '';
    lines.push(`  ${p.id.padEnd(28)} ${p.providerType.padEnd(16)} ${key}${active}${model}`);
  }
  return lines.join('\n');
}

function renderAgentSettingsText(s: AgentSettingsDTO): string {
  const out: string[] = ['agent settings:'];
  if (s.model !== undefined) out.push(`  model:          ${s.model}`);
  if (s.maxTokens !== undefined) out.push(`  maxTokens:      ${s.maxTokens}`);
  if (s.temperature !== undefined) out.push(`  temperature:    ${s.temperature}`);
  if (s.topP !== undefined) out.push(`  topP:           ${s.topP}`);
  if (s.topK !== undefined) out.push(`  topK:           ${s.topK}`);
  if (s.enableThinking !== undefined) out.push(`  enableThinking: ${s.enableThinking ? 'yes' : 'no'}`);
  if (s.thinkingBudget !== undefined) out.push(`  thinkingBudget: ${s.thinkingBudget}`);
  return out.join('\n');
}

function renderVisionText(s: VisionSettingsDTO): string {
  const out: string[] = ['vision settings:'];
  if (s.provider !== undefined) out.push(`  provider:  ${s.provider}`);
  if (s.model !== undefined) out.push(`  model:     ${s.model}`);
  if (s.baseUrl !== undefined) out.push(`  baseUrl:   ${s.baseUrl}`);
  if (s.enabled !== undefined) out.push(`  enabled:   ${s.enabled ? 'yes' : 'no'}`);
  if (s.hasKey !== undefined) out.push(`  hasKey:    ${s.hasKey ? 'yes' : 'no'}`);
  return out.join('\n');
}

function renderStylesText(styles: OutputStyleEntry[]): string {
  if (styles.length === 0) return '(no output styles registered)';
  const lines: string[] = [`${styles.length} output style${styles.length !== 1 ? 's' : ''} available`];
  for (const s of styles) {
    lines.push(`  ${s.id.padEnd(20)} ${s.name}`);
  }
  return lines.join('\n');
}

function renderPairingText(pending: PairingEntry[], approved: PairingEntry[]): string {
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push(`pending (${pending.length}):`);
    for (const p of pending) {
      lines.push(`  ${p.platform}  code=${p.code}  user=${p.platformUserId ?? '?'}`);
    }
  }
  if (approved.length > 0) {
    lines.push(`approved (${approved.length}):`);
    for (const p of approved) {
      lines.push(`  ${p.platform}  user=${p.platformUserId ?? '?'}`);
    }
  }
  if (lines.length === 0) return '(no pairing requests)';
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// argv → body coercion helpers
// ---------------------------------------------------------------------------

function numOpt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`expected number, got '${s}'`);
  }
  return n;
}

/**
 * Coerce `--env KEY=VAL` (repeatable) into a `Record<string,string>`.
 * Throws on missing `=`.
 */
function envArrayToObject(env: string[] | undefined): Record<string, string> | undefined {
  if (!env || env.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const e of env) {
    const idx = e.indexOf('=');
    if (idx < 0) throw new Error(`--env expects KEY=VAL, got '${e}'`);
    const k = e.slice(0, idx);
    const v = e.slice(idx + 1);
    if (k.length === 0) throw new Error(`--env has empty key in '${e}'`);
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function writeErrorAndExit(err: unknown): never {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    process.exit(err.isAppUnavailable() ? 2 : 1);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// `duya config provider …`
// ---------------------------------------------------------------------------

export async function runConfigProviderList(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ providers: ProviderDTO[] }>('/v1/config/providers');
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ providers: body.providers }) + '\n');
    } else {
      process.stdout.write(renderProvidersText(body.providers) + '\n');
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigProviderInfo(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('config provider info <id> — id is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ provider: ProviderDTO }>(
      `/v1/config/providers/${encodeURIComponent(id)}`,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ provider: body.provider }) + '\n');
    } else {
      process.stdout.write(renderProvidersText([body.provider]) + '\n');
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigProviderAdd(ctx: CliSubcommandContext): Promise<ExitCode> {
  const { configId, configName, configType, configBaseUrl, configApiKey, configActive } = ctx.options;
  if (typeof configId !== 'string' || typeof configName !== 'string' || typeof configType !== 'string') {
    process.stderr.write('config provider add — --id, --name, --type are required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; provider: ProviderDTO }>(
      '/v1/config/providers',
      {
        id: configId,
        name: configName,
        providerType: configType,
        baseUrl: configBaseUrl ?? '',
        apiKey: configApiKey ?? '',
        isActive: configActive === true,
      },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`provider '${configId}' added\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigProviderRemove(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('config provider remove <id> — id is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.delete<{ ok: boolean; removed: string }>(
      `/v1/config/providers/${encodeURIComponent(id)}`,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`provider '${id}' removed\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigProviderActivate(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('config provider activate <id> — id is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; active: string }>(
      `/v1/config/providers/${encodeURIComponent(id)}/activate`,
      {},
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`provider '${id}' activated\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

// ---------------------------------------------------------------------------
// `duya config settings …`
// ---------------------------------------------------------------------------

export async function runConfigSettingsShow(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ settings: AgentSettingsDTO }>('/v1/config/settings/agent');
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ settings: body.settings }) + '\n');
    } else {
      process.stdout.write(renderAgentSettingsText(body.settings) + '\n');
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigSettingsSet(ctx: CliSubcommandContext): Promise<ExitCode> {
  const o = ctx.options;
  const patch: Record<string, unknown> = {};
  if (typeof o.configModel === 'string') patch.model = o.configModel;
  if (typeof o.configMaxTokens === 'string') patch.maxTokens = numOpt(o.configMaxTokens);
  if (typeof o.configTemperature === 'string') patch.temperature = numOpt(o.configTemperature);
  if (typeof o.configTopP === 'string') patch.topP = numOpt(o.configTopP);
  if (typeof o.configTopK === 'string') patch.topK = numOpt(o.configTopK);
  if (o.configEnableThinking === true) patch.enableThinking = true;
  if (typeof o.configThinkingBudget === 'string') patch.thinkingBudget = numOpt(o.configThinkingBudget);
  if (Object.keys(patch).length === 0) {
    process.stderr.write(
      'config settings set — at least one of --model/--max-tokens/--temperature/--top-p/--top-k/--enable-thinking/--thinking-budget is required\n',
    );
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.patch<{ ok: boolean; changes: Record<string, unknown> }>(
      '/v1/config/settings/agent',
      patch,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`agent settings updated: ${Object.keys(patch).join(', ')}\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

// ---------------------------------------------------------------------------
// `duya config vision …`
// ---------------------------------------------------------------------------

export async function runConfigVisionShow(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ settings: VisionSettingsDTO }>('/v1/config/settings/vision');
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ settings: body.settings }) + '\n');
    } else {
      process.stdout.write(renderVisionText(body.settings) + '\n');
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigVisionSet(ctx: CliSubcommandContext): Promise<ExitCode> {
  const o = ctx.options;
  const patch: Record<string, unknown> = {};
  if (typeof o.configProvider === 'string') patch.provider = o.configProvider;
  if (typeof o.configModel === 'string') patch.model = o.configModel;
  if (typeof o.configBaseUrl === 'string') patch.baseUrl = o.configBaseUrl;
  if (typeof o.configApiKey === 'string') patch.apiKey = o.configApiKey;
  // Plan 102: `isActive` is renamed `enabled` at the wire boundary;
  // the legacy `duya_config` field has the same name on input, so the
  // CLI takes `--enabled` (cleaner) and the handler also accepts
  // `isActive` for forward compat (not exposed via CLI flag).
  if (o.configEnabled === true) patch.enabled = true;
  if (Object.keys(patch).length === 0) {
    process.stderr.write(
      'config vision set — at least one of --provider/--model/--base-url/--api-key/--enabled is required\n',
    );
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.patch<{ ok: boolean; changes: Record<string, unknown> }>(
      '/v1/config/settings/vision',
      patch,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`vision settings updated: ${Object.keys(patch).join(', ')}\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

// ---------------------------------------------------------------------------
// `duya config style …`
// ---------------------------------------------------------------------------

export async function runConfigStyleList(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ styles: OutputStyleEntry[] }>('/v1/config/output-styles');
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ styles: body.styles }) + '\n');
    } else {
      process.stdout.write(renderStylesText(body.styles) + '\n');
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigStyleSet(ctx: CliSubcommandContext): Promise<ExitCode> {
  const styleId = ctx.args[0] ?? ctx.options.configStyleId;
  if (typeof styleId !== 'string' || styleId.length === 0) {
    process.stderr.write('config style set <styleId> — styleId is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; styleId: string }>(
      '/v1/config/output-styles',
      { styleId },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`output style set to '${styleId}'\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

// ---------------------------------------------------------------------------
// `duya config pairing …`
// ---------------------------------------------------------------------------

export async function runConfigPairingList(ctx: CliSubcommandContext): Promise<ExitCode> {
  const include = ctx.options.configInclude;
  try {
    const client = await CliApiClient.connect();
    const path =
      include === 'approved'
        ? '/v1/config/pairing?include=approved'
        : include === 'pending'
        ? '/v1/config/pairing?include=pending'
        : '/v1/config/pairing';
    const body = await client.get<{ pending: PairingEntry[]; approved: PairingEntry[] }>(path);
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderPairingText(body.pending, body.approved) + '\n');
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigPairingApprove(ctx: CliSubcommandContext): Promise<ExitCode> {
  // Pull platform from the standard `platform` option bag (consistent
  // with `duya channel list --platform`); the pairing code lives in
  // the config-flavor slot so it doesn't collide with the legacy
  // `--code` cron flag.
  const p = ctx.options.platform;
  const code = ctx.options.configCode;
  if (typeof p !== 'string' || typeof code !== 'string') {
    process.stderr.write('config pairing approve — --platform and --code are required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean }>(
      '/v1/config/pairing/approve',
      { platform: p, code },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`pairing code approved for ${p}\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigPairingRevoke(ctx: CliSubcommandContext): Promise<ExitCode> {
  const p = ctx.options.platform;
  const u = ctx.options.configUser;
  if (typeof p !== 'string' || typeof u !== 'string') {
    process.stderr.write('config pairing revoke — --platform and --user are required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean }>(
      '/v1/config/pairing/revoke',
      { platform: p, platformUserId: u },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`pairing revoked for ${p}:${u}\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

export async function runConfigPairingCheck(ctx: CliSubcommandContext): Promise<ExitCode> {
  const p = ctx.options.platform;
  const u = ctx.options.configUser;
  if (typeof p !== 'string' || typeof u !== 'string') {
    process.stderr.write('config pairing check — --platform and --user are required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ approved: boolean }>(
      `/v1/config/pairing/check?platform=${encodeURIComponent(p)}&user=${encodeURIComponent(u)}`,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`${p}:${u} ${body.approved ? 'approved' : 'not approved'}\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}
