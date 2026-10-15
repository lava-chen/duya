/**
 * packages/cli/src/chat.ts 鈥?`duya chat`: the Host-backed chat client.
 *
 * This is the production chat entry for the Host architecture (plan 587/12).
 * It contains NO agent runtime: no `DuyaAgent`, no REPL over `streamChat`, no
 * `@duya/agent` import. Everything it does goes through the Host's versioned
 * HTTP API 鈥?start a run, follow its durable event stream, cancel on
 * Ctrl+C 鈥?exactly the same path the Desktop uses.
 *
 * Connection discovery order:
 *   1. `--origin` / `DUYA_HOST_ORIGIN` (with `--token` / `DUYA_HOST_TOKEN`
 *      when the Host was started with an explicit token)
 *   2. the Host runtime descriptor file `<dataRoot>/runtime/host-api.json`,
 *      written by `duya serve` (or any standalone Host process)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import readline from 'node:readline';
import type {
  DurableTimelineEntry,
  HostSessionListItem,
  HostSessionRecord,
  RunEvent,
  RunEventEnvelope,
  RunId,
  SessionId,
} from '@duya/agent-protocol';
import { projectTimelinePersistenceMessages } from '@duya/agent-protocol/transcript';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost } from '@duya/host/local-host';
import { resolveHostWorkerPath } from './worker-path.js';
import { resolveDataRoot } from '@duya/data';
import { TUIApp, shouldUseTui, type CompletionSources, type LegacyFrame, type TuiChoice } from './tui/index.js';
import { captureConsoleToFile } from './tui/console-capture.js';

interface RuntimeDescriptor {
  readonly apiVersion: number;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: number;
}

export interface ChatCommandOptions {
  readonly origin?: string;
  readonly token?: string;
  readonly runtimeFile?: string;
  readonly session?: string;
  readonly print?: string;
  readonly model?: string;
  readonly providerId?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
}

interface ResolvedConnection {
  readonly origin: string;
  readonly token: string;
  readonly source: string;
}

function readRuntimeDescriptor(file: string): ResolvedConnection | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let descriptor: RuntimeDescriptor;
  try {
    descriptor = JSON.parse(raw) as RuntimeDescriptor;
  } catch {
    return null;
  }
  if (descriptor.apiVersion !== 1 || typeof descriptor.port !== 'number') return null;
  return {
    origin: `http://${descriptor.host}:${descriptor.port}`,
    token: descriptor.token,
    source: file,
  };
}

function resolveConnection(options: ChatCommandOptions): ResolvedConnection {
  const envOrigin = options.origin ?? process.env.DUYA_HOST_ORIGIN;
  if (envOrigin !== undefined && envOrigin.trim().length > 0) {
    return {
      origin: envOrigin.trim().replace(/\/+$/, ''),
      token: options.token ?? process.env.DUYA_HOST_TOKEN ?? '',
      source: 'origin option/environment',
    };
  }
  const runtimeFile =
    options.runtimeFile ?? path.join(resolveDataRoot(), 'runtime', 'host-api.json');
  const fromFile = readRuntimeDescriptor(runtimeFile);
  if (fromFile !== null) return fromFile;
  throw new Error(
    `no Duya Host to connect to: pass --origin, set DUYA_HOST_ORIGIN, or start one with \`duya serve\` ` +
      `(no readable runtime descriptor at ${runtimeFile})`,
  );
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BRIGHT_CYAN = '\x1b[96m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Render one run event the way a chat terminal wants to see it. */
function renderEvent(event: RunEventEnvelope<RunEvent>): void {
  const payload = event.payload;
  switch (payload.type) {
    case 'assistant.text_block':
      write(payload.text);
      return;
    case 'tool.call_started':
      write(`${DIM}鈿?${payload.toolName}(${summarizeArguments(payload.arguments)})${RESET}`);
      return;
    case 'tool.call_completed': {
      const verdict = payload.outcome.outcome;
      const outcome =
        verdict === 'tool_error'
          ? `${RED}error${RESET}`
          : verdict === 'success'
            ? `${DIM}ok${RESET}`
            : verdict === 'timeout'
              ? `${YELLOW}timeout${RESET}`
              : verdict === 'cancelled'
                ? `${YELLOW}cancelled${RESET}`
                : `${YELLOW}?${RESET}`;
      const firstLine = payload.content.split('\n', 1)[0] ?? '';
      write(`${DIM}鈫?${outcome} ${firstLine.slice(0, 120)}${RESET}`);
      return;
    }
    case 'assistant.status':
      write(`${DIM}鈥?${payload.message}${RESET}`);
      return;
    default:
      // Every other event type is diagnostic for a chat terminal; the durable
      // log keeps them, the terminal does not spam them.
      return;
  }
}

function summarizeArguments(args: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  return keys
    .slice(0, 3)
    .map((key) => {
      const value = args[key];
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      return `${key}: ${text.slice(0, 40)}`;
    })
    .join(', ');
}

/**
 * Drive one run to its terminal: follow the durable event stream, render,
 * and return when the iterable closes (the watch contract ends at settle).
 */
async function driveRun(
  client: HostSessionHttpClient,
  runId: RunId,
  onInterrupt: (cancel: () => void) => void,
): Promise<string> {
  let terminal = 'unknown';
  let cancelled = false;
  onInterrupt(() => {
    cancelled = true;
    void client.cancelAgentRun(runId, 'chat interrupt (Ctrl+C)').catch(() => undefined);
  });
  try {
    for await (const event of client.watchAgentRunEvents(runId)) {
      renderEvent(event as RunEventEnvelope<RunEvent>);
      if (event.payload.type === 'run.completed') {
        terminal = String(
          (event.payload as { status?: string }).status ?? 'completed',
        );
      } else if (event.payload.type === 'run.failed') {
        terminal = 'failed';
      }
    }
  } catch (error) {
    if (!cancelled) {
      write(`${RED}event stream error: ${error instanceof Error ? error.message : String(error)}${RESET}`);
    }
  }
  // The stream can close before a terminal event was observed (dropped SSE
  // connection); ask the run record for the truth before giving up.
  if (terminal === 'unknown') {
    try {
      const record = await client.getAgentRun(runId);
      terminal = record?.status ?? 'unknown';
    } catch {
      // keep 'unknown'
    }
  }
  return terminal;
}

async function chatOnce(
  client: HostSessionHttpClient,
  sessionId: SessionId,
  prompt: string,
  options: ChatCommandOptions,
): Promise<number> {
  const start = await client.startAgentRun({
    sessionId,
    prompt,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    ...(options.apiFormat !== undefined ? { apiFormat: options.apiFormat } : {}),
    workingDirectory: process.cwd(),
  });
  if (!start.accepted) {
    write(`${RED}run refused: ${start.stage} 鈥?${start.reason ?? ''}${RESET}`);
    return 1;
  }
  write(`${DIM}run ${start.runId}${RESET}`);
  const terminal = await driveRun(client, start.runId, () => undefined);
  write(`${DIM}run ${start.runId}: ${terminal}${RESET}`);
  return terminal === 'completed' ? 0 : 1;
}

async function chatInteractive(
  client: HostSessionHttpClient,
  sessionId: SessionId,
  options: ChatCommandOptions,
): Promise<number> {
  if (shouldUseTui()) return chatTui(client, sessionId, options);

  write(`${DIM}session ${sessionId} 鈥?type a message, /exit to quit${RESET}`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BRIGHT_CYAN}you${RESET} ${DIM}鈥?{RESET} `,
  });
  let interrupt: (() => void) | null = null;
  let stopping = false;
  rl.on('SIGINT', () => {
    if (interrupt !== null) {
      interrupt();
      return;
    }
    stopping = true;
    rl.close();
  });

  await new Promise<void>((resolve) => {
    rl.prompt();
    rl.on('line', (line) => {
      const text = line.trim();
      if (text.length === 0) {
        rl.prompt();
        return;
      }
      if (text === '/exit' || text === '/quit' || text === '/q') {
        stopping = true;
        rl.close();
        return;
      }
      interrupt = null;
      void (async () => {
        try {
          const start = await client.startAgentRun({
            sessionId,
            prompt: text,
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
            ...(options.apiFormat !== undefined ? { apiFormat: options.apiFormat } : {}),
            workingDirectory: process.cwd(),
          });
          if (!start.accepted) {
            write(`${RED}run refused: ${start.stage} 鈥?${start.reason ?? ''}${RESET}`);
          } else {
            const terminal = await driveRun(client, start.runId, (cancel) => {
              interrupt = cancel;
            });
            write(`${DIM}run ${start.runId}: ${terminal}${RESET}`);
          }
        } catch (error) {
          write(`${RED}error: ${error instanceof Error ? error.message : String(error)}${RESET}`);
        } finally {
          interrupt = null;
          if (!stopping) rl.prompt();
        }
      })();
    });
    rl.on('close', resolve);
  });
  write(`${DIM}goodbye 鈥?session ${sessionId}${RESET}`);
  return 0;
}

async function createChatSession(
  client: HostSessionHttpClient,
  options: ChatCommandOptions,
): Promise<HostSessionRecord> {
  const workingDirectory = path.resolve(process.cwd());
  const workspace = await client.registerLocalDirectory(workingDirectory);
  return client.create({
    title: 'duya chat',
    projectName: path.basename(workingDirectory),
    workspaceId: workspace.workspaceId,
    workspaceRootId: workspace.rootId,
    workspaceRelativePath: workspace.relativePath,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
    mode: 'code',
  });
}

async function listWorkspaceSessions(
  client: HostSessionHttpClient,
  current: HostSessionRecord,
): Promise<HostSessionListItem[]> {
  const sessions: HostSessionListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.list({
      ...(current.workspace.state === 'bound' ? { workspaceId: current.workspace.workspaceId } : {}),
      limit: 100,
      includeArchived: false,
      includeAllSessions: current.workspace.state !== 'bound',
      includeDeleted: false,
      ...(cursor === undefined ? {} : { cursor }),
    });
    sessions.push(...page.sessions);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return sessions;
}

async function loadSessionMessages(
  client: HostSessionHttpClient,
  sessionId: string,
) {
  const entries: Extract<DurableTimelineEntry, { type: 'message' | 'compaction' }>[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.readMessages(sessionId, {
      limit: 200,
      includeSuperseded: false,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.messages) {
      if (item.entry.type === 'message' || item.entry.type === 'compaction') entries.push(item.entry);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return projectTimelinePersistenceMessages(entries);
}

/**
 * Whether to run the inline TUI.
 *
 * `DUYA_TUI_INLINE=1` opts in. The default is still the full-screen window
 * because the inline model is new here and its scrollback geometry has not been
 * exercised against a range of real terminals yet; codex, claude and minimax all
 * default to inline, and this is the switch that makes that reachable without a
 * rebuild.
 *
 * `DUYA_TUI_INLINE=0` is honoured as an explicit off, so a shell that exports
 * `DUYA_TUI_INLINE=1` globally can still turn it off for one run.
 */
export function inlineTuiRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['DUYA_TUI_INLINE'];
  if (value === undefined || value === '') return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}

function sessionLabel(item: HostSessionListItem): string {
  const { session, timelineCount } = item;
  return [
    session.title || 'Untitled session',
    `${session.providerId}/${session.model || 'default'}`,
    `${timelineCount} messages`,
    new Date(session.updatedAt).toLocaleString(),
    session.id.slice(0, 8),
  ].join('  路  ');
}

function sessionCompletionItem(item: HostSessionListItem) {
  return {
    label: sessionLabel(item),
    value: item.session.id,
    description: item.session.id,
    kind: 'slash_command' as const,
    category: 'command' as const,
    group: 'settings' as const,
  };
}

/** Translate the Host event contract into the renderer's narrow frame vocabulary. */
function tuiFrame(event: RunEventEnvelope<RunEvent>): LegacyFrame | null {
  const payload = event.payload;
  switch (payload.type) {
    case 'assistant.text_delta':
      return { type: 'text_delta', data: { content: payload.delta } };
    case 'assistant.text_block':
      return { type: 'text', data: { content: payload.text } };
    case 'assistant.thinking_delta':
      return { type: 'thinking_delta', data: { content: payload.delta } };
    case 'assistant.thinking_block':
      return { type: 'thinking', data: { content: payload.thinking } };
    case 'assistant.status':
      return { type: 'status', data: { message: payload.message } };
    case 'assistant.usage':
      return {
        type: 'token_usage',
        data: {
          input_tokens: payload.usage.inputTokens,
          output_tokens: payload.usage.outputTokens,
          total_tokens: payload.usage.totalTokens,
        },
      };
    case 'tool.call_preview':
      return {
        type: 'tool_use_started',
        data: { id: payload.toolCallId, name: payload.toolName, input: payload.arguments },
      };
    case 'tool.call_started':
      return {
        type: 'tool_use',
        data: { id: payload.toolCallId, name: payload.toolName, input: payload.arguments },
      };
    case 'tool.call_completed':
      return {
        type: 'tool_result',
        data: {
          id: payload.toolCallId,
          result: payload.content,
          error: payload.outcome.outcome !== 'success',
        },
      };
    case 'run.failed':
      return { type: 'error', data: { message: payload.error.message } };
    case 'run.completed':
      return { type: 'done' };
    default:
      return null;
  }
}

async function chatTui(
  client: HostSessionHttpClient,
  sessionId: SessionId,
  options: ChatCommandOptions,
): Promise<number> {
  const initialSession = await client.get(sessionId, { includeAllSessions: true });
  if (initialSession === null) throw new Error(`session ${sessionId} does not exist on this Host`);

  let activeSession = initialSession;
  let activeRunId: RunId | null = null;
  let busy = false;
  let finished = false;
  let finish: () => void = () => {};
  const finishedPromise = new Promise<void>((resolve) => { finish = resolve; });

  let sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
  const slashRows = [
    ['/resume', 'Resume a previous session'],
    ['/sessions', 'Browse previous sessions'],
    ['/new', 'Start a new session'],
    ['/clear', 'Clear the visible transcript'],
    ['/help', 'Show chat commands'],
    ['/exit', 'End this chat'],
  ].map(([label, description]) => ({
    label: label ?? '',
    value: label ?? '',
    description: description ?? '',
    kind: 'slash_command' as const,
    category: 'command' as const,
    group: 'settings' as const,
  }));
  const completionSources: CompletionSources = {
    slash: () => slashRows,
    slashOptions: (command) => command === '/resume' || command === '/sessions' ? sessionRows : [],
    slashOptionsOnBare: (command) => command === '/resume' || command === '/sessions',
    context: () => [],
    files: () => [],
  };

  const tui = new TUIApp({
    title: 'duya chat',
    inline: inlineTuiRequested(),
    completionSources,
    statusText: () => `${activeSession.providerId} 路 ${activeSession.model || options.model || 'default'} 路 ${activeSession.id.slice(0, 8)}`,
    isBusy: () => busy,
    onSubmit: (text) => { void handleLine(text); },
    onInterrupt: () => {
      if (activeRunId !== null) {
        void client.cancelAgentRun(activeRunId, 'chat interrupt (Ctrl+C)').catch(() => undefined);
      }
    },
    onExit: () => close(),
  });

  function close(): void {
    if (finished) return;
    finished = true;
    if (activeRunId !== null) {
      void client.cancelAgentRun(activeRunId, 'chat exit').catch(() => undefined);
    }
    tui.stop();
    finish();
  }

  async function resumeSession(query: string): Promise<void> {
    if (busy) {
      tui.printError('Wait for the current turn to finish before switching sessions.');
      return;
    }
    const sessions = await listWorkspaceSessions(client, activeSession);
    sessionRows = sessions.map(sessionCompletionItem);
    const normalized = query.trim().toLowerCase();
    const idMatches = normalized === ''
      ? []
      : sessions.filter(({ session }) => session.id.toLowerCase().startsWith(normalized));
    const choices: TuiChoice[] = sessions.map((item) => ({
      label: sessionLabel(item),
      value: item.session.id,
    }));
    if (choices.length === 0) {
      tui.printNotice('No sessions are available in this workspace.');
      return;
    }
    const selectedId = idMatches.length === 1
      ? idMatches[0]?.session.id ?? null
      : await tui.chooseFiltered('Resume session', choices, { initialFilter: query });
    if (selectedId === null) return;
    const selected = await client.get(selectedId, { includeAllSessions: true });
    if (selected === null) {
      tui.printError(`Session not found: ${selectedId}`);
      return;
    }
    activeSession = selected;
    tui.replaceTranscript(await loadSessionMessages(client, selectedId));
    tui.printNotice(`Resumed "${selected.title || 'Untitled session'}".`);
  }

  async function startNewSession(): Promise<void> {
    if (busy) {
      tui.printError('Wait for the current turn to finish before starting a new session.');
      return;
    }
    activeSession = await createChatSession(client, options);
    sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
    tui.clearTranscript();
    tui.printNotice(`Started a new session (${activeSession.id.slice(0, 8)}).`);
  }

  async function runTurn(prompt: string): Promise<void> {
    tui.printUser(prompt);
    busy = true;
    tui.setBusy(true);
    try {
      const start = await client.startAgentRun({
        sessionId: activeSession.id,
        prompt,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options.apiFormat !== undefined ? { apiFormat: options.apiFormat } : {}),
        workingDirectory: process.cwd(),
      });
      if (!start.accepted) {
        tui.printError(`run refused: ${start.stage} 鈥?${start.reason ?? ''}`);
        return;
      }
      activeRunId = start.runId;
      for await (const event of client.watchAgentRunEvents(start.runId)) {
        const frame = tuiFrame(event as RunEventEnvelope<RunEvent>);
        if (frame !== null) tui.push(frame);
      }
      const record = await client.getAgentRun(start.runId).catch(() => null);
      if (record?.status === 'failed') tui.printError(`Run ${start.runId} failed.`);
    } catch (error) {
      tui.printError(error instanceof Error ? error.message : String(error));
    } finally {
      activeRunId = null;
      busy = false;
      tui.setBusy(false);
      try {
        sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
      } catch {
        // Resume can retry the list when the user opens its submenu.
      }
    }
  }

  async function handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (text === '') return;
    const command = /^\/([^\s]+)(?:\s+(.*))?$/u.exec(text);
    if (command !== null) {
      const name = command[1]?.toLowerCase() ?? '';
      const args = command[2]?.trim() ?? '';
      try {
        if (name === 'exit' || name === 'quit' || name === 'q') close();
        else if (name === 'resume' || name === 'sessions') await resumeSession(args);
        else if (name === 'new') await startNewSession();
        else if (name === 'clear') tui.clearTranscript();
        else if (name === 'help') tui.printNotice('/resume 路 /sessions 路 /new 路 /clear 路 /exit');
        else tui.printError(`Unknown command: /${name}`);
      } catch (error) {
        tui.printError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (busy) {
      tui.printNotice('Wait for the current turn to finish before sending another message.');
      return;
    }
    await runTurn(text);
  }

  tui.replaceTranscript(await loadSessionMessages(client, sessionId));
  tui.printNotice(`session ${sessionId} 路 type a message, /resume to switch sessions`);
  tui.start();
  await finishedPromise;
  return 0;
}

export interface TuiCommandOptions {
  readonly port?: number;
  readonly session?: string;
  readonly model?: string;
  readonly providerId?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
}

/**
 * Entry for the `duya tui` command. Starts an ephemeral Host and opens the
 * full-screen TUI in the same process. The Host is shut down when the TUI exits.
 * Returns the process exit code.
 */
export async function runTuiCommand(options: TuiCommandOptions): Promise<number> {
  const host = await startLocalHost({
    port: options.port,
    ephemeral: true,
    workerPath: resolveHostWorkerPath(),
  });
  const client = new HostSessionHttpClient(host.origin, host.token ?? '');
  try {
    const health = await client.getHealth();
    write(`${DIM}duya tui 路 Host ${host.origin} (api v${health.apiVersion})${RESET}`);
  } catch (error) {
    write(`${RED}Host failed to start: ${error instanceof Error ? error.message : String(error)}${RESET}`);
    return 1;
  }

  let sessionId: SessionId;
  if (options.session !== undefined && options.session.trim().length > 0) {
    sessionId = options.session.trim() as SessionId;
    const existing = await client.readLocalSession(sessionId, { includeAllSessions: true });
    if (existing === null) {
      write(`${RED}session ${sessionId} does not exist on this Host${RESET}`);
      return 1;
    }
  } else {
    const created = await createChatSession(client, { ...options, origin: host.origin, token: host.token });
    sessionId = created.id;
  }

  let exitCode = 0;
  // From here the TUI owns this terminal. `blessed` renders through its own
  // writer, so any `console.*` call from this process lands inline in the
  // transcript and buries the turn the user asked for. Route it to the Host's
  // diagnostics log for the rest of the TUI's life. `process.stdout` and
  // `process.stderr` are deliberately NOT patched 鈥?that is what blessed draws.
  const consoleCapture =
    host.diagnosticsLogPath === undefined
      ? undefined
      : captureConsoleToFile(host.diagnosticsLogPath);
  try {
    exitCode = await chatInteractive(client, sessionId, { ...options, origin: host.origin, token: host.token });
  } finally {
    try {
      await host.close();
    } finally {
      consoleCapture?.restore();
    }
  }
  return exitCode;
}

/** Entry for the `duya chat` command. Returns the process exit code. */
export async function runChatCommand(options: ChatCommandOptions): Promise<number> {
  const connection = resolveConnection(options);
  const client = new HostSessionHttpClient(connection.origin, connection.token);
  try {
    const health = await client.getHealth();
    write(`${DIM}connected to Duya Host at ${connection.origin} (${connection.source}; api v${health.apiVersion})${RESET}`);
  } catch (error) {
    write(`${RED}Duya Host at ${connection.origin} is not reachable: ${error instanceof Error ? error.message : String(error)}${RESET}`);
    return 1;
  }

  let sessionId: SessionId;
  if (options.session !== undefined && options.session.trim().length > 0) {
    sessionId = options.session.trim() as SessionId;
    const existing = await client.readLocalSession(sessionId, { includeAllSessions: true });
    if (existing === null) {
      write(`${RED}session ${sessionId} does not exist on this Host${RESET}`);
      return 1;
    }
  } else {
    const created = await createChatSession(client, options);
    sessionId = created.id;
  }

  if (options.print !== undefined) {
    return chatOnce(client, sessionId, options.print, options);
  }
  return chatInteractive(client, sessionId, options);
}
