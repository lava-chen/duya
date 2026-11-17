/**
 * packages/cli/src/commands/project-channel.ts
 *
 * `duya project channel` — the local operator's control plane for one Project's
 * own Discord bot identity.
 *
 * Why this is NOT in `program/descriptors.ts`: that registry is projected into
 * the model-facing `duya_cli` tool. These subcommands take a bot credential and
 * change who may talk to a Project, so they must never be reachable from a
 * model turn, however well-behaved the model claims to be. Keeping them out of
 * the descriptor set is the structural guarantee; `resolveSubcommand` simply
 * does not know the path exists.
 *
 * Credential handling:
 *   - `--token` is refused on sight. argv is visible in `ps`, shell history and
 *     every wrapper that logs the command line.
 *   - The token comes from `DUYA_DISCORD_BOT_TOKEN`, or from stdin when a pipe
 *     is attached. It is never echoed, never logged, and never written to the
 *     output of any subcommand.
 *
 * Exit codes follow the control-plane convention:
 *   0 success · 1 generic · 2 Host unavailable · 3 interactive required
 *   64 usage error
 */

import type { CliApiClient } from '../api/client.js';
import { CliApiClient as Client } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';

/** The control-plane exit codes this surface can produce. */
type Exit = 0 | 1 | 2 | 3 | 64;

const ok = (n: Exit): Exit => n;

/** The env var a credential may come from. Nothing else is read from the env. */
export const PROJECT_CHANNEL_TOKEN_ENV = 'DUYA_DISCORD_BOT_TOKEN';

export interface ProjectChannelCommandOptions {
  readonly projectId?: string;
  readonly connectionId?: string;
  readonly bindingId?: string;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly members?: readonly string[];
  readonly expectedRevision?: number;
  readonly allowProactive?: boolean;
  readonly enabled?: boolean;
  readonly label?: string;
  /** Present only so it can be refused with an explanation. */
  readonly plaintextToken?: string;
  readonly format: OutputFormat;
}

// ─── Wire shapes (the Host's projection, read-only here) ─────────────────────

interface ChannelConnectionDTO {
  connectionId: string;
  projectId: string;
  platform: string;
  botUserId: string;
  label: string;
  enabled: boolean;
  revision: number;
  generation: number;
  credentialConfigured: boolean;
}

interface ChannelBindingDTO {
  bindingId: string;
  connectionId: string;
  guildId: string;
  channelId: string;
  allowedUserIds: readonly string[];
  allowProactive: boolean;
  enabled: boolean;
  revision: number;
  label: string;
}

interface ChannelObservationDTO {
  state: string;
  observedBotUserId: string;
  errorCode: string | null;
  observedAt: number;
}

interface ChannelDeliveryDTO {
  deliveryId: string;
  bindingId: string;
  status: string;
  platformMessageId: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ChannelOverviewDTO {
  projectId: string;
  connection: ChannelConnectionDTO | null;
  bindings: readonly ChannelBindingDTO[];
  observation: ChannelObservationDTO | null;
  deliveries: { deliveries: readonly ChannelDeliveryDTO[]; nextCursor: number | null };
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

class UsageError extends Error {}

/**
 * How a subcommand reaches the Host.
 *
 * Injectable so a test can point the same code path at a Host it started
 * itself: a CLI test that stubs the formatting but not the wire proves nothing
 * about whether the route exists.
 */
export interface ProjectChannelDeps {
  readonly client?: () => Promise<CliApiClient>;
}

async function connect(deps: ProjectChannelDeps): Promise<CliApiClient> {
  return deps.client === undefined ? Client.connect() : deps.client();
}

function path(projectId: string, suffix = ''): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/channels${suffix}`;
}

/**
 * Report a failure without ever including request material.
 *
 * The domain code is not on the wire for these routes (the status is), so the
 * remedy is derived from the status: 404 means the thing you named is gone, 409
 * means somebody changed it under you, 503 means Discord is not reachable.
 */
function reportFailure(error: unknown, action: string): Exit {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    return 64;
  }
  if (error instanceof CliApiError) {
    if (error.isAppUnavailable()) {
      process.stderr.write(
        `No running Duya Host to ${action}. Project channels are configured against a live Host `
        + `(start one with \`duya serve\`, or use the desktop app).\n`,
      );
      return 2;
    }
    const status = error.httpStatus;
    if (status === 404) {
      process.stderr.write(`${action}: not found. ${error.message}\n`);
      return 1;
    }
    if (status === 409) {
      process.stderr.write(
        `${action}: the record changed since you read it (${error.message}). `
        + `Re-run \`duya project channel status\` and pass the current --revision.\n`,
      );
      return 1;
    }
    if (status === 503) {
      process.stderr.write(`${action}: Discord is not reachable right now (${error.message}).\n`);
      return 1;
    }
    if (status === 400) {
      process.stderr.write(`${action}: refused (${error.message}).\n`);
      return 1;
    }
    process.stderr.write(`${action}: ${error.hint || error.message}\n`);
    return 1;
  }
  process.stderr.write(`${action}: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

/**
 * Read the credential from the env or a pipe.
 *
 * Never from argv: a bot token in argv is visible to every process on the
 * machine, survives in shell history, and ends up in bug reports.
 */
async function readCredential(options: ProjectChannelCommandOptions): Promise<string> {
  if (options.plaintextToken !== undefined) {
    throw new UsageError(
      '--token is not accepted: credentials must not appear on the command line.\n'
      + `Set ${PROJECT_CHANNEL_TOKEN_ENV} instead, or pipe the token on stdin: `
      + '`read -rs TOKEN && printf %s "$TOKEN" | duya project channel connect --project <id>`',
    );
  }
  const fromEnv = process.env[PROJECT_CHANNEL_TOKEN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  if (process.stdin.isTTY) {
    throw new UsageError(
      `No credential: set ${PROJECT_CHANNEL_TOKEN_ENV}, or pipe the token on stdin. `
      + 'It is deliberately not read from a flag.',
    );
  }
  const piped = (await readAll(process.stdin)).trim();
  if (piped === '') {
    throw new UsageError(`No credential on stdin and ${PROJECT_CHANNEL_TOKEN_ENV} is not set.`);
  }
  return piped;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function requireProjectId(options: ProjectChannelCommandOptions): string {
  const projectId = options.projectId?.trim();
  if (projectId === undefined || projectId === '') {
    throw new UsageError('--project <id> is required.');
  }
  return projectId;
}

function requireOption(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') throw new UsageError(`${flag} is required.`);
  return trimmed;
}

function requireRevision(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new UsageError('--revision <n> is required: these writes are compare-and-set, not last-writer-wins.');
  }
  return value;
}

// ─── Renderers ──────────────────────────────────────────────────────────────

function renderConnection(connection: ChannelConnectionDTO | null, observation: ChannelObservationDTO | null): string {
  if (connection === null) return 'connection: none configured\n';
  const lines = [
    `connection: ${connection.connectionId}`,
    `  label:       ${connection.label || '(none)'}`,
    `  bot:         ${connection.botUserId}`,
    `  enabled:     ${connection.enabled ? 'yes' : 'no'}`,
    `  revision:    ${connection.revision}`,
    `  credential:  ${connection.credentialConfigured ? 'configured' : 'missing'}`,
    `  transport:   ${observation === null ? 'never started' : `${observation.state}${observation.errorCode === null ? '' : ` (${observation.errorCode})`}`}`,
  ];
  return `${lines.join('\n')}\n`;
}

function renderBindings(bindings: readonly ChannelBindingDTO[]): string {
  if (bindings.length === 0) return 'bindings: none\n';
  const rows = bindings.map((b) => [
    b.bindingId.slice(0, 8),
    b.label || '-',
    `${b.guildId}/${b.channelId}`,
    String(b.allowedUserIds.length),
    b.allowProactive ? 'yes' : 'no',
    b.enabled ? 'enabled' : 'revoked',
    `r${b.revision}`,
  ]);
  const header = ['BINDING', 'LABEL', 'GUILD/CHANNEL', 'MEMBERS', 'PROACTIVE', 'STATE', 'REV'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}

function renderDeliveries(page: ChannelOverviewDTO['deliveries']): string {
  if (page.deliveries.length === 0) return 'deliveries: none\n';
  const rows = page.deliveries.map((d) => [
    d.deliveryId.slice(0, 8),
    d.status,
    d.platformMessageId ?? '-',
    d.errorCode ?? '-',
  ]);
  const header = ['DELIVERY', 'STATUS', 'PLATFORM ID', 'ERROR'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}

function emit(payload: unknown, text: string, format: OutputFormat): void {
  process.stdout.write(format === 'json' ? `${renderJson(payload)}\n` : text);
}

async function overviewOf(client: CliApiClient, projectId: string): Promise<ChannelOverviewDTO> {
  const result = await client.get<{ overview: ChannelOverviewDTO | null }>(path(projectId));
  if (result.overview === null) throw new Error(`project ${projectId} was not found by the Host`);
  return result.overview;
}

// ─── Subcommands ────────────────────────────────────────────────────────────

/** `duya project channel list` — bindings and their permissions. */
export async function runProjectChannelList(
  options: ProjectChannelCommandOptions,
  deps: ProjectChannelDeps = {},
): Promise<Exit> {
  try {
    const projectId = requireProjectId(options);
    const overview = await overviewOf(await connect(deps), projectId);
    emit(overview, renderBindings(overview.bindings), options.format);
    return ok(0);
  } catch (error) {
    return reportFailure(error, 'List channels');
  }
}

/** `duya project channel status` — connection, transport and recent deliveries. */
export async function runProjectChannelStatus(
  options: ProjectChannelCommandOptions,
  deps: ProjectChannelDeps = {},
): Promise<Exit> {
  try {
    const projectId = requireProjectId(options);
    const overview = await overviewOf(await connect(deps), projectId);
    const text = renderConnection(overview.connection, overview.observation)
      + renderBindings(overview.bindings)
      + renderDeliveries(overview.deliveries);
    emit(overview, text, options.format);
    return ok(0);
  } catch (error) {
    return reportFailure(error, 'Read channel status');
  }
}

/**
 * `duya project channel connect` — configure or rotate the bot credential.
 *
 * Rotation is a CAS on `--revision`; omitting it on an existing connection is
 * refused by the Host rather than silently taking over the identity.
 */
export async function runProjectChannelConnect(
  options: ProjectChannelCommandOptions,
  deps: ProjectChannelDeps = {},
): Promise<Exit> {
  try {
    const projectId = requireProjectId(options);
    const token = await readCredential(options);
    const client = await connect(deps);
    const result = await client.put<{ connection: ChannelConnectionDTO }>(path(projectId, '/connection'), {
      requestId: `cli-connect-${Date.now()}`,
      token,
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    emit(
      result,
      `configured ${result.connection.botUserId} (revision ${result.connection.revision})\n`
      + `credential stored; the Host will not print it back\n`
      + `next: \`duya project channel bind --project ${projectId} --connection ${result.connection.connectionId} `
      + '--guild <guildId> --channel <channelId> --member <userId>`\n',
      options.format,
    );
    return ok(0);
  } catch (error) {
    return reportFailure(error, 'Configure the Discord connection');
  }
}

/** `duya project channel bind` — authorize one guild channel and a member allowlist. */
export async function runProjectChannelBind(
  options: ProjectChannelCommandOptions,
  deps: ProjectChannelDeps = {},
): Promise<Exit> {
  try {
    const projectId = requireProjectId(options);
    const connectionId = requireOption(options.connectionId, '--connection <id>');
    const guildId = requireOption(options.guildId, '--guild <id>');
    const channelId = requireOption(options.channelId, '--channel <id>');
    const members = (options.members ?? []).map((id) => id.trim()).filter((id) => id !== '');
    if (members.length === 0) {
      throw new UsageError(
        '--member <userId> is required at least once: a binding with no allowed members would accept '
        + 'everyone in the channel, which is not what "authorized" means.',
      );
    }
    const client = await connect(deps);
    const result = await client.post<{ binding: ChannelBindingDTO }>(path(projectId, '/bindings'), {
      requestId: `cli-bind-${Date.now()}`,
      connectionId,
      guildId,
      channelId,
      allowedUserIds: members,
      allowProactive: options.allowProactive === true,
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    emit(
      result,
      `bound ${result.binding.bindingId} → ${guildId}/${channelId}\n`
      + `members:      ${members.join(', ')}\n`
      + `proactive:    ${result.binding.allowProactive ? 'allowed' : 'not allowed (default)'}\n`,
      options.format,
    );
    return ok(0);
  } catch (error) {
    return reportFailure(error, 'Bind the channel');
  }
}

/** `duya project channel update` — CAS patch of members, proactive and enabled. */
export async function runProjectChannelUpdate(
  options: ProjectChannelCommandOptions,
  deps: ProjectChannelDeps = {},
): Promise<Exit> {
  try {
    const projectId = requireProjectId(options);
    const bindingId = requireOption(options.bindingId, '--binding <id>');
    const expectedRevision = requireRevision(options.expectedRevision);
    const members = (options.members ?? []).map((id) => id.trim()).filter((id) => id !== '');
    const patch = {
      requestId: `cli-update-${Date.now()}`,
      expectedRevision,
      ...(members.length === 0 ? {} : { allowedUserIds: members }),
      ...(options.allowProactive === undefined ? {} : { allowProactive: options.allowProactive }),
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options.label === undefined ? {} : { label: options.label }),
    };
    const client = await connect(deps);
    const result = await client.patch<{ binding: ChannelBindingDTO | null }>(
      path(projectId, `/bindings/${encodeURIComponent(bindingId)}`),
      patch,
    );
    if (result.binding === null) throw new Error('binding not found');
    emit(result, `updated ${result.binding.bindingId} (revision ${result.binding.revision})\n`, options.format);
    return ok(0);
  } catch (error) {
    return reportFailure(error, 'Update the binding');
  }
}

/** `duya project channel unbind` — revoke a binding; the credential stays. */
export async function runProjectChannelUnbind(
  options: ProjectChannelCommandOptions,
  deps: ProjectChannelDeps = {},
): Promise<Exit> {
  try {
    const projectId = requireProjectId(options);
    const bindingId = requireOption(options.bindingId, '--binding <id>');
    const expectedRevision = requireRevision(options.expectedRevision);
    const client = await connect(deps);
    // The precondition travels as query parameters because the shared client's
    // DELETE carries no body; the Host accepts either form.
    const query = `?requestId=${encodeURIComponent(`cli-unbind-${Date.now()}`)}&expectedRevision=${expectedRevision}`;
    const result = await client.delete<{ binding: ChannelBindingDTO | null }>(
      path(projectId, `/bindings/${encodeURIComponent(bindingId)}${query}`),
    );
    if (result.binding === null) throw new Error('binding not found');
    emit(result, `revoked ${result.binding.bindingId}\n`, options.format);
    return ok(0);
  } catch (error) {
    return reportFailure(error, 'Revoke the binding');
  }
}

/**
 * `duya project channel disconnect` — disable the connection.
 *
 * Disabling is local: it does not claim the remote Discord application or its
 * token was deleted. The token also stays in the secret store so a reconnect
 * does not need it re-entered.
 */
export async function runProjectChannelDisconnect(
  options: ProjectChannelCommandOptions,
  deps: ProjectChannelDeps = {},
): Promise<Exit> {
  try {
    const projectId = requireProjectId(options);
    const connectionId = requireOption(options.connectionId, '--connection <id>');
    const expectedRevision = requireRevision(options.expectedRevision);
    const client = await connect(deps);
    const result = await client.post<{ connection: ChannelConnectionDTO | null }>(
      path(projectId, '/connection/disconnect'),
      { requestId: `cli-disconnect-${Date.now()}`, connectionId, expectedRevision },
    );
    if (result.connection === null) throw new Error('connection not found');
    emit(
      result,
      `disconnected ${result.connection.connectionId}\n`
      + 'the connection is disabled locally; the Discord application and its token were not deleted\n'
      + 'bound channels stay recorded but will not receive or send\n',
      options.format,
    );
    return ok(0);
  } catch (error) {
    return reportFailure(error, 'Disconnect the connection');
  }
}
