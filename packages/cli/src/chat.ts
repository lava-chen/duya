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
import { spawn } from 'node:child_process';
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
import type { PopoverItem } from '@duya/input-completion';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost } from '@duya/host/local-host';
import { resolveHostWorkerPath } from './worker-path.js';
import { resolveDataRoot } from '@duya/data';
import { TUIApp, shouldUseTui, type CompletionSources, type TuiChoice } from './tui/index.js';
import { HostEventStream } from './tui/host-event-stream.js';
import { TurnQueue, type TurnOutcome } from './tui/turn-queue.js';
import { captureConsoleToFile } from './tui/console-capture.js';
import {
  DEFAULT_TUI_PREFERENCES,
  readTuiPreferences,
  resolveEffectiveTuiPreferences,
} from './tui/preferences.js';
import {
  buildSlashCompletionRows,
  buildSlashHelpSections,
  hasTuiSlashCommand,
  resolveTuiSlashCommand,
} from './tui/slash/index.js';

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

/**
 * Commands this TUI dispatches itself, grouped with the same category names
 * the Desktop app registry uses (apps/desktop/src/renderer/lib/commands/registry.ts),
 * so one mental model covers both surfaces.
 *
 * Only commands this loop actually dispatches are listed. The registry-backed
 * commands (`/model`, `/status`, `/usage`, `/context`, `/transcript`,
 * `/export`) live in `./tui/slash/` and append their own groups at render
 * time — see `buildSlashHelpSections`.
 */
const HELP_SECTIONS: ReadonlyArray<{ readonly title: string; readonly lines: readonly string[] }> = [
  {
    title: 'Session',
    lines: [
      '/new                    Start a new session (fresh id, empty history)',
      '/resume [query]         Search and resume a previous session',
      '/sessions               Alias for /resume',
      '/clear                  Clear the transcript view',
      '/exit, /quit, /q        Leave the chat',
    ],
  },
  {
    title: 'Queue',
    lines: [
      '/queue                  Show queued follow-ups (resume or clear)',
      '/queue clear            Discard queued follow-ups',
      '/queue resume           Resume queued follow-ups',
    ],
  },
  {
    title: 'Info',
    lines: [
      '/help                   Show this list',
      '!cmd                    Run a shell command here (e.g. !git status)',
    ],
  },
  {
    title: 'Elsewhere',
    lines: [
      'The Desktop composer exposes more: permission modes, panel commands',
      '(/diff /memory /mcp), user skills as slash commands, and mode toggles.',
      'Type /help in the Desktop composer for that set.',
    ],
  },
];

/** Hard cap on combined stdout+stderr for a `!cmd` line, in characters. */
const BANG_OUTPUT_LIMIT = 8000;
/** Wall-clock cap for a `!cmd` line, in milliseconds. */
const BANG_TIMEOUT_MS = 30_000;

interface ShellResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/**
 * Run one shell line locally and collect its combined output.
 *
 * Runs against `process.cwd()`: the TUI is the user's own terminal, so `!pwd`
 * should report the directory they launched the chat from, and a `!cd`
 * should not silently drift away from it.
 */
function runShellLine(command: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    let output = '';
    let truncated = false;
    let timedOut = false;

    const append = (chunk: Buffer | string): void => {
      if (truncated) return;
      const text = chunk.toString();
      const room = BANG_OUTPUT_LIMIT - output.length;
      if (text.length <= room) {
        output += text;
        return;
      }
      output += text.slice(0, Math.max(0, room)) + '\n[output truncated]';
      truncated = true;
      child.kill();
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BANG_TIMEOUT_MS);

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, output: error.message, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
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
  ].join('  ·  ');
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

export async function chatTui(
  client: HostSessionHttpClient,
  sessionId: SessionId,
  options: ChatCommandOptions,
): Promise<number> {
  let savedPreferences = DEFAULT_TUI_PREFERENCES;
  try {
    savedPreferences = await readTuiPreferences(client);
  } catch {
    // Keep environment/default behavior if the Host's local settings endpoint
    // is unavailable, so an optional preference never prevents starting chat.
  }
  const effectivePreferences = resolveEffectiveTuiPreferences(savedPreferences);

  const initialSession = await client.get(sessionId, { includeAllSessions: true });
  if (initialSession === null) throw new Error(`session ${sessionId} does not exist on this Host`);

  let activeSession = initialSession;
  let activeRunId: RunId | null = null;
  let activeStream: AbortController | null = null;
  const pendingCancellations = new Map<RunId, Promise<void>>();
  let busy = false;
  let cancellationRequested = false;
  let sessionTransition = false;
  let finished = false;
  let finish: () => void = () => {};
  const finishedPromise = new Promise<void>((resolve) => { finish = resolve; });

  let sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
  const sessionSlashRows: PopoverItem[] = [
    ['/resume', 'Resume a previous session'],
    ['/sessions', 'Browse previous sessions'],
    ['/new', 'Start a new session'],
    ['/clear', 'Clear the visible transcript'],
    ['/queue', 'Resume or clear pending follow-ups'],
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
  const slashRows: PopoverItem[] = [...sessionSlashRows, ...buildSlashCompletionRows()];
  const completionSources: CompletionSources = {
    slash: () => slashRows,
    slashOptions: (command) => command === '/resume' || command === '/sessions' ? sessionRows : [],
    slashOptionsOnBare: (command) => command === '/resume' || command === '/sessions',
    context: () => [],
    files: () => [],
  };

  const queue = new TurnQueue({
    execute: runTurn,
    onChange: (snapshot) => {
      busy = snapshot.busy;
      if (!finished) {
        tui.setBusy(busy);
        tui.refresh();
      }
    },
    onError: (error) => {
      if (!finished) tui.printError(error instanceof Error ? error.message : String(error));
    },
  });

  function requestRemoteCancellation(runId: RunId, reason: string): Promise<void> {
    const existing = pendingCancellations.get(runId);
    if (existing !== undefined) return existing;
    const pending = client.cancelAgentRun(runId, reason)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!finished) tui.printError(error instanceof Error ? error.message : String(error));
      });
    pendingCancellations.set(runId, pending);
    void pending.finally(() => {
      if (pendingCancellations.get(runId) === pending) pendingCancellations.delete(runId);
    });
    return pending;
  }

  function interrupt(): void {
    cancellationRequested = true;
    queue.pause();
    // Stop waiting for the live SSE body immediately. Host cancellation is a
    // separate request and can be slow when the worker/tool is wedged.
    activeStream?.abort();
    if (activeRunId !== null) {
      void requestRemoteCancellation(activeRunId, 'chat interrupt');
    }
  }

  const tui = new TUIApp({
    title: 'duya chat',
    theme: effectivePreferences.theme,
    inline: effectivePreferences.displayMode === 'inline',
    completionSources,
    echoSubmitted: false,
    canSubmit: () => !sessionTransition,
    queuedPrompts: () => queue.snapshot.pending,
    queuedCount: () => queue.snapshot.pending.length,
    queuePaused: () => queue.snapshot.paused,
    onRecallQueued: () => queue.takeLast(),
    statusText: () => `${activeSession.providerId} · ${activeSession.model || options.model || 'default'} · ${activeSession.id.slice(0, 8)}`,
    isBusy: () => busy,
    onSubmit: (text) => { void handleLine(text); },
    onInterrupt: interrupt,
    onExit: () => close(),
  });

  function close(): void {
    if (finished) return;
    finished = true;
    queue.close();
    cancellationRequested = true;
    activeStream?.abort();
    tui.stop();
    // Keep the Host alive until even an in-flight startup has been cancelled.
    void (async () => {
      try {
        if (activeRunId !== null) await requestRemoteCancellation(activeRunId, 'chat exit');
      } catch {
        // The owned Host is closed by the caller after this barrier settles.
      } finally {
        await queue.whenIdle();
        await Promise.all([...pendingCancellations.values()]);
        finish();
      }
    })();
  }

  async function resumeSession(query: string): Promise<void> {
    if (busy || queue.snapshot.pending.length > 0) {
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
    if (busy || queue.snapshot.pending.length > 0) {
      tui.printError('Wait for the current turn to finish before starting a new session.');
      return;
    }
    activeSession = await createChatSession(client, options);
    sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
    tui.clearTranscript();
    tui.printNotice(`Started a new session (${activeSession.id.slice(0, 8)}).`);
  }

  /**
   * Switch to another session and repaint: used by `/resume` and by `/fork`,
   * which lands in a session this loop never saw. Extracted so both paths
   * reload the transcript and refresh the session list the same way.
   */
  async function adoptSession(sessionId: string): Promise<void> {
    const adopted = await client.get(sessionId, { includeAllSessions: true });
    if (adopted === null) {
      tui.printError(`Session not found: ${sessionId}`);
      return;
    }
    activeSession = adopted;
    sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
    tui.replaceTranscript(await loadSessionMessages(client, adopted.id));
    tui.printNotice(`Switched to "${adopted.title || 'Untitled session'}" (${adopted.id.slice(0, 8)}).`);
  }

  async function runTurn(prompt: string): Promise<TurnOutcome> {
    cancellationRequested = false;
    const streamAbort = new AbortController();
    activeStream = streamAbort;
    const runSessionId = activeSession.id;
    // Pending drafts enter the transcript only when admitted to a Host turn.
    tui.printUser(prompt);
    try {
      const start = await client.startAgentRun({
        sessionId: runSessionId,
        prompt,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options.apiFormat !== undefined ? { apiFormat: options.apiFormat } : {}),
        workingDirectory: process.cwd(),
      });
      if (!start.accepted) {
        if (cancellationRequested || finished) return 'cancelled';
        if (!finished) tui.printError('Run refused: ' + start.stage + ' - ' + (start.reason ?? ''));
        return 'failed';
      }
      activeRunId = start.runId;
      // Interrupt/exit may arrive while the start request is still in flight.
      if (cancellationRequested || finished) {
        void requestRemoteCancellation(start.runId, 'chat interrupted during startup');
        return 'cancelled';
      }
      const stream = new HostEventStream(runSessionId, start.runId);
      for await (const event of client.watchAgentRunEvents(start.runId, { signal: streamAbort.signal })) {
        if (finished) return 'cancelled';
        const frame = stream.push(event);
        if (frame !== null) tui.push(frame);
      }
      if (cancellationRequested || finished) return 'cancelled';
      const record = await client.getAgentRun(start.runId);
      if (record === null) {
        tui.printError('Run stream closed without a settled record. Pending drafts are paused.');
        return 'failed';
      }
      if (record.status === 'failed') {
        tui.printError('Run ' + start.runId + ' failed.');
        return 'failed';
      }
      if (cancellationRequested || record.status === 'cancelled') return 'cancelled';
      if (record.status !== 'completed') {
        tui.printError('Run stopped with status ' + record.status + '. Pending drafts are paused.');
        return 'failed';
      }
      return 'completed';
    } catch (error) {
      if (!finished && !cancellationRequested) {
        tui.printError(error instanceof Error ? error.message : String(error));
      }
      return cancellationRequested ? 'cancelled' : 'failed';
    } finally {
      activeStream = null;
      activeRunId = null;
      if (!finished && !cancellationRequested) {
        try {
          sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
        } catch {
          // Resume can retry the list when the user opens its submenu.
        }
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
        else if (name === 'resume' || name === 'sessions' || name === 'new') {
          if (sessionTransition) return;
          sessionTransition = true;
          try {
            if (name === 'new') await startNewSession();
            else await resumeSession(args);
          } finally {
            sessionTransition = false;
          }
        }
        else if (name === 'queue') {
          if (args === 'clear') queue.clear();
          else if (args === 'resume') queue.resume();
          else {
            const choice = await tui.choose('Pending follow-ups', [
              { label: 'Resume queued follow-ups', value: 'resume' },
              { label: 'Discard queued follow-ups', value: 'clear' },
            ]);
            if (choice === 'resume') queue.resume();
            else if (choice === 'clear') queue.clear();
          }
        }
        else if (name === 'clear') tui.clearTranscript();
        else if (hasTuiSlashCommand(name)) {
          // Registry-backed commands (model/status/usage/context/transcript/
          // export). They own their own I/O and return a structured outcome;
          // the only thing this loop has to apply is a replaced session
          // record so the status line and the next run use the new model.
          const slash = resolveTuiSlashCommand(name);
          if (slash === undefined) throw new Error(`unreachable: /${name} passed hasTuiSlashCommand`);
          const outcome = await slash.run(
            {
              client,
              session: activeSession,
              tui,
              busy,
              // Actions only this loop can perform: they touch the queue, the
              // transcript and the status line. `/fork`, `/archive`,
              // `/delete` and `/stop` are wired here rather than inside the
              // command module.
              actions: {
                interrupt,
                adoptSession: adoptSession,
                startFreshSession: startNewSession,
              },
            },
            args,
          );
          if (outcome.kind === 'session_updated') {
            activeSession = outcome.session;
            if (!finished) tui.refresh();
          }
        }
        else if (name === 'help') {
          tui.printNotice('Available commands:');
          for (const section of [...HELP_SECTIONS, ...buildSlashHelpSections()]) {
            tui.printNotice(`[${section.title}]`);
            for (const line of section.lines) tui.printNotice(`  ${line}`);
          }
        }
        else tui.printError(`Unknown command: /${name}`);
      } catch (error) {
        tui.printError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    // Bang prefix: `!cmd` runs a shell command in this terminal and prints
    // the result instead of sending it to the agent (minimax/codex parity,
    // and the same contract the Desktop composer implements). Checked after
    // the slash branch because `!/usr/bin/...` is a path, not a command.
    if (text.startsWith('!')) {
      const shellLine = text.slice(1).trim();
      if (shellLine === '') {
        tui.printError('Usage: !<shell command>');
        return;
      }
      tui.printNotice(`$ ${shellLine}`);
      try {
        const result = await runShellLine(shellLine);
        for (const line of result.output.split('\n')) tui.printNotice(line);
        if (result.timedOut) {
          tui.printError(`Command timed out after ${BANG_TIMEOUT_MS / 1000}s`);
        } else if (result.code !== null && result.code !== 0) {
          tui.printError(
            `Exited with code ${result.code}`
            + (result.signal === null ? '' : ` (signal ${result.signal})`),
          );
        }
      } catch (error) {
        tui.printError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    queue.submit(line);

  }

  tui.replaceTranscript(await loadSessionMessages(client, sessionId));
  tui.printNotice(`session ${sessionId} · type a message, /resume to switch sessions`);
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
 * Entry for the `duya tui` command. Starts an ephemeral Host and opens the TUI
 * in the same process. The Host is shut down when the TUI exits. Which screen
 * model that TUI uses is `inlineTuiRequested`; this entry point is the same
 * either way. Returns the process exit code.
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
    write(`${DIM}duya tui · Host ${host.origin} (api v${health.apiVersion})${RESET}`);
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
