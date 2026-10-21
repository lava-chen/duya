/**
 * packages/cli/src/commands/agent.ts
 *
 * `duya agent …` — create / list / delete custom config-driven agents.
 *
 * Each subcommand is a thin wrapper around the desktop's /v1/config/agents
 * HTTP routes (added in `electron/cli/handlers/config.ts` and registered in
 * `electron/cli/cli-api-server.ts`). The actual persistence lives in the
 * main process; the CLI only ships `{ id, name, description?, model?,
 * workspace?, agents_md?, tools?, plugins? }` bodies across the wire.
 *
 * `agents_md` is a file PATH, not embedded content — the desktop handler
 * reads the file itself. This command only ensures the workspace directory
 * exists and (optionally) seeds a placeholder instructions file.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTO — matches the agent shape in electron/cli/handlers/config.ts
// ---------------------------------------------------------------------------

export interface AgentDTO {
  name?: string;
  description?: string;
  model?: string;
  workspace?: string;
  agents_md?: string;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  plugins?: string[];
}

export interface AgentListDTO {
  agents: Record<string, AgentDTO>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable, URL/object-key-safe id from a display name.
 * `slugify('My Cool Agent!') === 'my-cool-agent'`.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Normalize a CLI-provided list value into a non-empty string[].
 * Tolerates both Commander's collected array (repeatable flag) and a
 * single comma-separated string (see build-control-plane.ts).
 */
export function toList(v: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(v)) {
    const xs = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return xs.length > 0 ? xs : undefined;
  }
  if (typeof v === 'string' && v.length > 0) {
    const xs = v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return xs.length > 0 ? xs : undefined;
  }
  return undefined;
}

function writeErrorAndExit(err: unknown): never {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    process.exit(err.isAppUnavailable() ? 2 : 1);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// `duya agent list`
// ---------------------------------------------------------------------------

export async function runAgentList(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<AgentListDTO>('/v1/config/agents');
    if (ctx.format === 'json') {
      process.stdout.write(renderJson({ agents: body.agents }) + '\n');
    } else {
      const entries = Object.entries(body.agents ?? {});
      if (entries.length === 0) {
        process.stdout.write('(no custom agents configured)\n');
      } else {
        const lines: string[] = ['id  name  model  workspace  agents_md'];
        for (const [id, a] of entries) {
          lines.push(
            `${id}  ${a.name ?? ''}  ${a.model ?? ''}  ${a.workspace ?? ''}  ${a.agents_md ?? ''}`,
          );
        }
        process.stdout.write(lines.join('\n') + '\n');
      }
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

// ---------------------------------------------------------------------------
// `duya agent create`
// ---------------------------------------------------------------------------

export async function runAgentCreate(ctx: CliSubcommandContext): Promise<ExitCode> {
  const o = ctx.options;
  let name = typeof o.agentName === 'string' && o.agentName.length > 0 ? o.agentName : undefined;
  let workspace =
    typeof o.agentWorkspace === 'string' && o.agentWorkspace.length > 0
      ? o.agentWorkspace
      : undefined;
  let model = typeof o.agentModel === 'string' && o.agentModel.length > 0 ? o.agentModel : undefined;
  let toolsProfile =
    typeof o.agentToolsProfile === 'string' && o.agentToolsProfile.length > 0
      ? o.agentToolsProfile
      : undefined;
  let instructionsFile =
    typeof o.agentInstructionsFile === 'string' && o.agentInstructionsFile.length > 0
      ? o.agentInstructionsFile
      : undefined;

  // Interactive fallback: no --name on a TTY triggers a guided prompt.
  if (!name && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      name = (await rl.question('Agent name: ')).trim();
      if (name) {
        const ws = (await rl.question('Workspace path (optional, Enter to skip): ')).trim();
        if (ws) workspace = ws;
        const m = (await rl.question('Model (optional, Enter to skip): ')).trim();
        if (m) model = m;
        const tp = (await rl.question('Tools profile (optional, Enter to skip): ')).trim();
        if (tp) toolsProfile = tp;
        const ins = (await rl.question('Instructions file path (optional, Enter to skip): ')).trim();
        if (ins) instructionsFile = ins;
      }
    } finally {
      rl.close();
    }
  }

  if (!name) {
    process.stderr.write('agent create — --name <name> is required (or run interactively on a TTY)\n');
    return 64;
  }

  const id = typeof o.agentId === 'string' && o.agentId.length > 0 ? o.agentId : slugify(name);
  if (!id) {
    process.stderr.write('agent create — could not derive an id from the name; pass --id <id>\n');
    return 64;
  }

  // Ensure the workspace directory exists.
  if (workspace) {
    fs.mkdirSync(workspace, { recursive: true });
  }

  // agents_md is a file PATH. Seed a placeholder only when the file is
  // missing; never read/embed its content into the config.
  let agents_md: string | undefined;
  if (instructionsFile) {
    if (!fs.existsSync(instructionsFile)) {
      fs.mkdirSync(instructionsFile.replace(/[^/\\]+$/, '') || '.', { recursive: true });
      fs.writeFileSync(instructionsFile, `# ${name}\n\nCustom agent global instructions.\n`, 'utf8');
    }
    agents_md = instructionsFile;
  }

  const tools: Record<string, unknown> = {};
  if (toolsProfile) tools.profile = toolsProfile;
  const allow = toList(o.agentAllow);
  const deny = toList(o.agentDeny);
  if (allow) tools.allow = allow;
  if (deny) tools.deny = deny;

  const body: Record<string, unknown> = { id, name };
  if (typeof o.agentDescription === 'string' && o.agentDescription.length > 0) {
    body.description = o.agentDescription;
  }
  if (model) body.model = model;
  if (workspace) body.workspace = workspace;
  if (agents_md) body.agents_md = agents_md;
  if (Object.keys(tools).length > 0) body.tools = tools;
  const plugins = toList(o.agentPlugins);
  if (plugins) body.plugins = plugins;

  try {
    const client = await CliApiClient.connect();
    const result = await client.post<{ ok: boolean; agent: Record<string, unknown> }>(
      '/v1/config/agents',
      body,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else {
      process.stdout.write(`agent '${name}' created (id: ${id})\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}

// ---------------------------------------------------------------------------
// `duya agent delete`
// ---------------------------------------------------------------------------

export async function runAgentDelete(ctx: CliSubcommandContext): Promise<ExitCode> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('agent delete <id> — id is required\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.delete<{ ok: boolean; removed: string }>(
      `/v1/config/agents/${encodeURIComponent(id)}`,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else {
      process.stdout.write(`agent '${id}' removed\n`);
    }
    return 0;
  } catch (err) {
    return writeErrorAndExit(err), 0;
  }
}