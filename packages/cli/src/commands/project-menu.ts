import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { clearScreenDown, emitKeypressEvents, moveCursor, type Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { ProjectChannelBinding, ProjectChannelConnection, ProjectChannelOverview } from '@duya/agent-protocol/project-channels';
import type { HostProjectRecord } from '@duya/agent-protocol/projects';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { truncateToWidth } from '../tui/width.js';
import { PROJECT_CHANNEL_TOKEN_ENV } from './project-channel.js';

type Choice<T> = { label: string; value: T };
const print = (line: string): void => { process.stdout.write(`${line}\n`); };
const terminalText = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');

function openPrompts() {
  let secret = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (secret) done();
      else process.stdout.write(chunk, done);
    },
  });
  const cancellation = new AbortController();
  const close = () => cancellation.abort();

  async function ask(label: string, options: { fallback?: string; hidden?: boolean } = {}): Promise<string | null> {
    if (cancellation.signal.aborted) return null;
    const prompt = options.fallback === undefined ? `${label}: ` : `${label} [${terminalText(options.fallback)}]: `;
    secret = options.hidden === true;
    const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    input.once('close', close);
    input.on('SIGINT', close);
    if (secret) process.stdout.write(prompt);
    try {
      const answer = (await input.question(secret ? '' : prompt, { signal: cancellation.signal })).trim();
      return answer || options.fallback || '';
    } catch (error) {
      if (cancellation.signal.aborted) return null;
      throw error;
    } finally {
      input.off('close', close);
      input.close();
      if (secret) print('');
      secret = false;
    }
  }

  async function choose<T>(title: string, choices: readonly Choice<T>[]): Promise<T | null> {
    if (cancellation.signal.aborted || choices.length === 0) return null;
    if (process.env.TERM !== 'dumb') return chooseWithKeyboard(title, choices, cancellation);

    print(`\n${terminalText(title)}`);
    choices.forEach(({ label }, index) => print(`  ${index + 1}) ${terminalText(label)}`));
    for (;;) {
      const answer = await ask('Choose a number or q to go back', { fallback: '1' });
      if (answer === null || answer.toLowerCase() === 'q') return null;
      if (/^\d+$/u.test(answer)) {
        const selected = choices[Number(answer) - 1];
        if (selected !== undefined) return selected.value;
      }
      print(`Enter a number from 1 to ${choices.length}.`);
    }
  }

  return { ask, choose, close, get closed() { return cancellation.signal.aborted; } };
}

async function chooseWithKeyboard<T>(
  title: string,
  choices: readonly Choice<T>[],
  cancellation: AbortController,
): Promise<T | null> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  let selected = 0;
  let top = 0;
  let painted = 0;

  function clear(): void {
    if (painted === 0) return;
    moveCursor(output, 0, -painted);
    clearScreenDown(output);
    painted = 0;
  }

  function render(): void {
    clear();
    const limit = Math.max(1, Math.min(10, (output.rows || 24) - 3));
    top = Math.min(top, Math.max(0, choices.length - limit));
    if (selected < top) top = selected;
    if (selected >= top + limit) top = selected - limit + 1;
    const rows = [
      terminalText(title),
      ...choices.slice(top, top + limit).map(({ label }, index) =>
        `${top + index === selected ? '›' : ' '} ${terminalText(label)}`),
      '↑/↓ Move · Enter Select · Esc Back',
    ];
    const width = Math.max(1, (output.columns || 80) - 1);
    output.write(rows.map((row) => truncateToWidth(row, width)).join('\r\n') + '\r\n');
    painted = rows.length;
  }

  let onKey: ((_input: string | undefined, key: Key) => void) | undefined;
  let onEnd: (() => void) | undefined;
  try {
    emitKeypressEvents(input);
    input.setRawMode(true);
    return await new Promise<T | null>((resolve) => {
      onEnd = () => {
        cancellation.abort();
        resolve(null);
      };
      onKey = (_input, key) => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) return onEnd?.();
        // Node readline marks a bare Escape as a meta key.
        if (key.sequence === '\x1b') return resolve(null);
        if (key.ctrl || key.meta) return;
        if (key.name === 'q') return resolve(null);
        if (key.name === 'return' || key.name === 'enter') return resolve(choices[selected]!.value);
        if (key.name === 'up' || key.name === 'down') {
          selected = (selected + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
          render();
        }
      };
      input.on('keypress', onKey);
      input.once('end', onEnd);
      input.resume();
      print('');
      render();
    });
  } finally {
    if (onKey) input.off('keypress', onKey);
    if (onEnd) input.off('end', onEnd);
    input.pause();
    if (input.isRaw !== wasRaw) input.setRawMode(wasRaw);
    clear();
  }
}

type Prompts = ReturnType<typeof openPrompts>;

export async function selectProject(
  client: HostSessionHttpClient,
  connection: { origin: string; token: string },
  options: { projectId?: string; channelsOnly?: boolean },
): Promise<HostProjectRecord | null> {
  const listNamed = async () => (await client.listProjects()).filter(({ name, canonical_root }) => name.trim() !== '' && canonical_root.trim() !== '');
  const specified = options.projectId === undefined ? null : await client.getProject(options.projectId.trim());
  if (options.projectId !== undefined && specified === null) throw new Error(`Project "${options.projectId}" does not exist.`);
  if (specified !== null && !options.channelsOnly) return specified;

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    if (options.channelsOnly) throw new Error('Channel setup needs an interactive terminal. Use channel connect and bind for scripting.');
    const projects = await listNamed();
    if (projects.length === 1) return projects[0]!;
    throw new Error('Run duya project in a terminal to create or choose a project, or pass --project <id>.');
  }

  const prompts = openPrompts();
  const channels = new CliApiClient(connection.origin, connection.token);
  try {
    if (specified !== null) {
      await manageChannels(channels, specified, prompts);
      return null;
    }
    for (;;) {
      if (prompts.closed) return null;
      const recent = (await listNamed())
        .sort((a, b) => b.last_seen_at - a.last_seen_at || a.name.localeCompare(b.name));
      const entry = await prompts.choose<HostProjectRecord | 'create'>('Projects', [
        ...recent.map((project) => ({ label: `${project.name}  ·  ${project.canonical_root}`, value: project })),
        { label: 'Create a project', value: 'create' },
      ]);
      if (entry === null) return null;
      let project: HostProjectRecord | null;
      try {
        project = entry === 'create' ? await createProject(client, prompts) : entry;
      } catch (error) {
        print(`Could not create the project. ${error instanceof Error ? terminalText(error.message) : 'Try another folder.'}`);
        continue;
      }
      if (project === null) continue;
      if (options.channelsOnly) {
        await manageChannels(channels, project, prompts);
        return null;
      }
      for (;;) {
        const action = await prompts.choose(`${project.name}`, [
          { label: 'Open Coordinator', value: 'open' },
          { label: 'Manage Discord channels', value: 'discord' },
        ]);
        if (action === null) break;
        if (action === 'open') return project;
        await manageChannels(channels, project, prompts);
      }
    }
  } finally {
    prompts.close();
  }
}

async function createProject(client: HostSessionHttpClient, prompts: Prompts): Promise<HostProjectRecord | null> {
  const folder = await prompts.ask('Existing project folder', { fallback: process.cwd() });
  if (folder === null) return null;
  const canonical = path.resolve(folder === '~' ? homedir() : /^~[/\\]/u.test(folder) ? path.join(homedir(), folder.slice(2)) : folder);
  const name = await prompts.ask('Project name', { fallback: path.basename(canonical) || 'Project' });
  if (name === null) return null;
  if ((await prompts.ask(`Create "${terminalText(name)}" in ${terminalText(canonical)}? (y/N)`))?.toLowerCase() !== 'y') return null;
  const project = await client.createProject({ name, paths: [{ path: canonical, description: null }] });
  print(`Created ${terminalText(project.name)}.`);
  return project;
}

const DISCORD_CHANNEL_LINK = /^https:\/\/(?:discord\.com|discordapp\.com)\/channels\/(\d{5,25})\/(\d{5,25})\/?$/u;
const DISCORD_ID = /^\d{5,25}$/u;

async function manageChannels(client: CliApiClient, project: HostProjectRecord, prompts: Prompts): Promise<void> {
  const route = `/v1/projects/${encodeURIComponent(project.project_id)}/channels`;
  while (!prompts.closed) {
    let overview: ProjectChannelOverview | null;
    try {
      ({ overview } = await client.get<{ overview: ProjectChannelOverview | null }>(route));
    } catch (error) {
      if (error instanceof CliApiError && error.httpStatus === 404) {
        print('This Host has no Discord channel support. Close Duya clients using this data directory, then run duya serve. Reopen duya project in a second terminal.');
      } else {
        print('Could not read Discord channel settings. Check that the Host is running.');
      }
      return;
    }
    const connection = overview?.connection ?? null;
    const status = connection === null ? 'Bot not configured' : overview?.observation?.state ?? 'Bot configured · connection unobserved';
    print(`\nDiscord · ${terminalText(project.name)} · ${status}`);
    for (const binding of overview?.bindings ?? []) {
      print(`  ${terminalText(binding.label || binding.channelId)} · ${binding.enabled ? 'enabled' : 'disabled'} · ${binding.allowedUserIds.length} allowed`);
    }
    const choice = await prompts.choose('Discord settings', [
      { label: connection?.enabled ? 'Add a channel' : 'Connect a bot and add a channel', value: 'bind' },
      ...(connection?.enabled ? [{ label: 'Update bot token', value: 'token' }] : []),
    ]);
    if (choice === null) return;
    try {
      if (choice === 'token') {
        await configureBot(client, route, connection, prompts);
        continue;
      }
      const target = await prompts.ask('Discord channel link (Copy Channel Link)');
      if (target === null || target === '') continue;
      const match = DISCORD_CHANNEL_LINK.exec(target);
      if (!match) { print('Paste the full https://discord.com/channels/server/channel link.'); continue; }
      const [, guildId, channelId] = match;
      if ((overview?.bindings ?? []).some((item) => item.guildId === guildId && item.channelId === channelId && item.enabled)) {
        print('This channel is already connected.'); continue;
      }
      const members = await prompts.ask('Allowed Discord user IDs, separated by spaces or commas');
      if (members === null) continue;
      const allowedUserIds = [...new Set(members.split(/[\s,]+/u).filter(Boolean))];
      if (allowedUserIds.length === 0 || !allowedUserIds.every((id) => DISCORD_ID.test(id))) {
        print('Enter at least one numeric user ID (Copy User ID in Discord Developer Mode).'); continue;
      }
      const label = await prompts.ask('Channel label (optional)');
      if (label === null) continue;
      if ((await prompts.ask(`Allow these ${allowedUserIds.length} users to talk to the Coordinator in this channel? (y/N)`))?.toLowerCase() !== 'y') continue;
      const active = connection?.enabled ? connection : await configureBot(client, route, connection, prompts);
      if (active === null) continue;
      const { binding } = await client.post<{ binding: ProjectChannelBinding }>(`${route}/bindings`, {
        requestId: randomUUID(), connectionId: active.connectionId, guildId, channelId, allowedUserIds,
        ...(label ? { label } : {}),
      }, { timeoutMs: 20_000 });
      print(`Channel ${terminalText(binding.label || binding.channelId)} linked. Mention the bot in Discord to try it.`);
    } catch (error) {
      const status = error instanceof CliApiError ? error.httpStatus : undefined;
      print(status === 409 ? 'The settings changed. Read them again and retry.'
        : status === 503 ? 'Discord is unreachable. Check the bot connection and retry.'
        : 'Discord setup was refused. Check the token, channel link and bot permissions.');
    }
  }
}

async function configureBot(
  client: CliApiClient, route: string, connection: ProjectChannelConnection | null, prompts: Prompts,
): Promise<ProjectChannelConnection | null> {
  const envToken = process.env[PROJECT_CHANNEL_TOKEN_ENV]?.trim();
  const useEnv = envToken && (await prompts.ask(`Use ${PROJECT_CHANNEL_TOKEN_ENV}? (y/N)`))?.toLowerCase() === 'y';
  const token = useEnv ? envToken : await prompts.ask('Discord bot token (hidden)', { hidden: true });
  if (!token) return null;
  const result = await client.put<{ connection: ProjectChannelConnection }>(`${route}/connection`, {
    requestId: randomUUID(), token,
    ...(connection === null ? {} : { expectedRevision: connection.revision }),
  }, { timeoutMs: 45_000 });
  print('Discord bot verified and saved.');
  return result.connection;
}
