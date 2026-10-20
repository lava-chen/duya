/**
 * packages/cli/src/chat.ts —`duya chat`: the Host-backed chat client.
 *
 * This is the production chat entry for the Host architecture (plan 587/12).
 * It contains NO agent runtime: no `DuyaAgent`, no REPL over `streamChat`, no
 * `@duya/agent` import. Everything it does goes through the Host's versioned
 * HTTP API —start a run, follow its durable event stream, cancel on
 * Ctrl+C —exactly the same path the Desktop uses.
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
import { describeSpec, findSpec, type CommandLocale } from '@duya/command-catalog';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { resolveDataRoot } from '@duya/data';
import { TUIApp, shouldUseTui, type CompletionSources, type TuiChoice } from './tui/index.js';
import { isDestructiveRequest, type QuestionAnswers } from './tui/overlay.js';
import { HostEventStream } from './tui/host-event-stream.js';
import { createRunSessionView, projectRunSessionView } from './tui/run-session-view.js';
import { RunSession } from '@duya/client-core';
import { TurnQueue, type TurnOutcome } from './tui/turn-queue.js';
import { createFileCompletionSource } from './tui/candidates.js';
import { captureConsoleToFile } from './tui/console-capture.js';
import { OwnedSessions } from './owned-sessions.js';
import { normalizeEffort } from './tui/theme.js';
import {
  DEFAULT_TUI_PREFERENCES,
  effortForModel,
  readTuiPreferences,
  resolveEffectiveTuiPreferences,
  TUI_EFFORT_SETTING,
  type TuiPreferences,
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
  readonly diagnosticsLogPath?: string;
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

const BRIGHT_CYAN = '\x1b[96m';
const YELLOW = '\x1b[33m';

/**
 * Plain-terminal line writer and the three codes `tui-command.ts` needs to
 * print its pre-TUI status and error lines. The Host bootstrap prints through
 * the client's writer so the plain-output path has exactly one implementation.
 */
export const DIM = '\x1b[2m';
export const RESET = '\x1b[0m';
export const RED = '\x1b[31m';

export function write(line: string): void {
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
      write(`${DIM}—${payload.message}${RESET}`);
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
    write(`${RED}run refused: ${start.stage} —${start.reason ?? ''}${RESET}`);
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
function helpSections(locale: CommandLocale): ReadonlyArray<{
  readonly title: string;
  readonly lines: readonly string[];
}> {
  const chinese = locale === 'zh';
  const description = (name: string, fallback: string): string => {
    const spec = findSpec(name);
    return spec === undefined ? fallback : describeSpec(spec, locale);
  };
  return [
    {
      title: chinese ? '会话' : 'Session',
      lines: [
        `/new                    ${description('new', chinese ? '开始新会话' : 'Start a new session')}`,
        `/resume [query]         ${description('resume', chinese ? '搜索并恢复历史会话' : 'Search and resume a previous session')}`,
        `/sessions               ${chinese ? '浏览历史会话' : 'Browse previous sessions'}`,
        `/clear                  ${description('clear', chinese ? '清空当前对话' : 'Clear the conversation')}`,
        `/exit, /quit, /q        ${chinese ? '退出当前聊天' : 'Leave the chat'}`,
      ],
    },
    {
      title: chinese ? '队列' : 'Queue',
      lines: chinese
        ? ['/queue                  查看排队的后续消息', '/queue clear            丢弃排队消息', '/queue resume           继续处理排队消息']
        : ['/queue                  Show queued follow-ups (resume or clear)', '/queue clear            Discard queued follow-ups', '/queue resume           Resume queued follow-ups'],
    },
    {
      title: chinese ? '信息' : 'Info',
      lines: [
        `/help                   ${description('help', chinese ? '显示命令列表' : 'Show this list')}`,
        chinese ? '!cmd                    在此终端执行 shell 命令（例如 !git status）' : '!cmd                    Run a shell command here (e.g. !git status)',
      ],
    },
    {
      title: chinese ? '桌面端' : 'Desktop',
      lines: chinese
        ? ['桌面端还提供权限模式、面板命令（/diff /memory /mcp）、用户技能和模式切换。', '在桌面端输入 /help 查看完整列表。']
        : ['The Desktop composer also exposes permission modes, panel commands', '(/diff /memory /mcp), user skills as slash commands, and mode toggles.', 'Type /help in the Desktop composer for that set.'],
    },
  ];
}

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

/**
 * Drive the full-screen / inline TUI against an already-connected Host client.
 *
 * Exported for `tui-command.ts`, which is the bootstrap half of `duya tui`:
 * it owns starting the Host, this owns everything after the client exists.
 */
export async function chatInteractive(
  client: HostSessionHttpClient,
  sessionId: SessionId,
  options: ChatCommandOptions,
  owned?: OwnedSessions,
): Promise<number> {
  if (shouldUseTui()) return chatTui(client, sessionId, options, owned);

  write(`${DIM}session ${sessionId} —type a message, /exit to quit${RESET}`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BRIGHT_CYAN}you${RESET} ${DIM}—{RESET} `,
  });
  let interrupt: (() => void) | null = null;
  let stopping = false;
  /** Runs still streaming; a live run owns the session and may still write to it. */
  let activeRuns = 0;
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
        activeRuns += 1;
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
            write(`${RED}run refused: ${start.stage} —${start.reason ?? ''}${RESET}`);
          } else {
            // See the TUI path: a session a turn was started on is never
            // deleted, because the worker is the one that writes the user's
            // message into the timeline.
            owned?.markUsed(sessionId);
            const terminal = await driveRun(client, start.runId, (cancel) => {
              interrupt = cancel;
            });
            write(`${DIM}run ${start.runId}: ${terminal}${RESET}`);
          }
        } catch (error) {
          write(`${RED}error: ${error instanceof Error ? error.message : String(error)}${RESET}`);
        } finally {
          activeRuns -= 1;
          interrupt = null;
          if (!stopping) rl.prompt();
        }
      })();
    });
    rl.on('close', resolve);
  });
  // A run that is still streaming owns the session: the worker may be about to
  // persist the user's message into it. Leave the row alone until it settles
  // — a session deleted under a live run loses the turn it was given.
  if (activeRuns === 0) await owned?.releaseEmpty(client);
  write(`${DIM}goodbye —session ${sessionId}${RESET}`);
  return 0;
}

/** Exported for `tui-command.ts`; see the note on `chatInteractive`. */
export async function createChatSession(
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

/**
 * The sessions of this workspace that are worth resuming.
 *
 * A session with an empty timeline is skipped. Those are the rows a chat
 * surface leaves behind when it is opened and closed without a message: the
 * Host session has to exist before a run can belong to it, so the surface
 * creates one up front and the row survives the exit. Offering those in the
 * resume picker is offering a conversation that has none — and there is one
 * of them for every chat that was opened and closed, so the list fills up
 * with ghosts the user cannot tell apart from real sessions.
 *
 * The row itself is cleaned up by `OwnedSessions` when the surface that
 * created it closes; this filter is what keeps the already-existing ghosts
 * out of the list.
 */
function isResumable(item: HostSessionListItem): boolean {
  return item.timelineCount > 0;
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
    sessions.push(...page.sessions.filter(isResumable));
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

/**
 * `auto` on the wire is "no effort field at all", which is what the worker
 * reads as "let the model decide". One place, because the same question is
 * asked at startup, after `/effort`, and after every model switch.
 */
function nullifyAuto(level: string): string | null {
  return level === 'auto' ? null : level;
}

/**
 * Re-read the saved preferences and resolve effort for a (new) model.
 *
 * Re-read rather than trust the in-memory set because `/settings` writes
 * `cli.tui.effortByModel` straight to the Host: a model switch that used a
 * stale map would silently apply last week's override. A failed read keeps the
 * last known set — a preference must never strand the switch.
 */
async function reloadEffortForModel(
  client: HostSessionHttpClient,
  current: TuiPreferences,
  model: string | undefined,
): Promise<{ preferences: TuiPreferences; effort: string | null }> {
  let preferences = current;
  try {
    preferences = await readTuiPreferences(client);
  } catch {
    // Keep `current`.
  }
  return { preferences, effort: nullifyAuto(effortForModel(preferences, model)) };
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
  owned?: OwnedSessions,
): Promise<number> {
  let savedPreferences = DEFAULT_TUI_PREFERENCES;
  try {
    savedPreferences = await readTuiPreferences(client);
  } catch {
    // Keep environment/default behavior if the Host's local settings endpoint
    // is unavailable, so an optional preference never prevents starting chat.
  }
  let locale: CommandLocale = savedPreferences.locale;
  const effectivePreferences = resolveEffectiveTuiPreferences(savedPreferences);

  const initialSession = await client.get(sessionId, { includeAllSessions: true });
  if (initialSession === null) throw new Error(`session ${sessionId} does not exist on this Host`);

  let activeSession = initialSession;
  /**
   * Reasoning effort for subsequent runs, or null for "let the model decide".
   *
   * Held here rather than on the session record because the Host takes effort
   * per run (`StartAgentRunInput.effort`) and never persists it. `/effort`
   * rewrites this and persists the choice through the settings endpoint, so the
   * composer border after a restart is the same colour the user left it.
   *
   * Seeded per MODEL (`cli.tui.effortByModel` first, then the global value):
   * the level that is right for a cheap model is wrong for a reasoning one,
   * and a default the user has to re-set after every `/model` is not a
   * default. Re-resolved whenever the session's model actually changes.
   */
  let effort: string | null = nullifyAuto(effortForModel(effectivePreferences, initialSession.model));
  /**
   * Re-resolve effort when the active session's model actually changed.
   *
   * Not on every session swap: `/resume` into a session with the same model
   * must keep the level the user picked a minute ago. Only a different model
   * is a reason to drop their choice, and it is one because the choice was
   * made FOR a model.
   */
  async function resyncEffortForModelChange(previousModel: string | undefined): Promise<void> {
    if (activeSession.model === previousModel) return;
    const reloaded = await reloadEffortForModel(client, savedPreferences, activeSession.model);
    savedPreferences = reloaded.preferences;
    effort = reloaded.effort;
  }
  let activeRunId: RunId | null = null;
  let activeStream: AbortController | null = null;
  const pendingCancellations = new Map<RunId, Promise<void>>();
  let busy = false;
  let cancellationRequested = false;
  let unsettledRunId: RunId | null = null;
  let sessionTransition = false;
  let finished = false;
  let finish: () => void = () => {};
  const finishedPromise = new Promise<void>((resolve) => { finish = resolve; });

  let sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
  const sessionSlashRows = (): PopoverItem[] => {
    const commands: readonly (readonly [string, string, string, string])[] = [
      ['/resume', 'resume', 'Search and resume a previous session', '搜索并切换到之前的会话'],
      ['/sessions', 'resume', 'Browse previous sessions', '浏览历史会话'],
      ['/new', 'new', 'Start a new session', '开始一个新会话'],
      ['/clear', 'clear', 'Clear the visible transcript', '清空当前对话'],
      ['/queue', 'queue', 'Resume or clear pending follow-ups', '继续或清除排队的后续消息'],
      ['/help', 'help', 'Show chat commands', '显示聊天命令'],
      ['/exit', 'exit', 'End this chat', '结束当前聊天'],
    ];
    return commands.map(([label, specName, english, chinese]) => {
      const spec = findSpec(specName);
      return {
        label,
        value: label,
        description: spec === undefined
          ? locale === 'zh' ? chinese : english
          : describeSpec(spec, locale),
        kind: 'slash_command' as const,
        category: 'command' as const,
        group: 'settings' as const,
      };
    });
  };
  // `@` offers workspace paths. The walk is cached briefly rather than for the
  // session — see `createFileCompletionSource` — because a chat session lives
  // long enough for the tree to change under it.
  const fileCandidates = createFileCompletionSource(path.resolve(process.cwd()));
  const completionSources: CompletionSources = {
    slash: () => [...sessionSlashRows(), ...buildSlashCompletionRows({ locale })],
    slashOptions: (command) => command === '/resume' || command === '/sessions' ? sessionRows : [],
    slashOptionsOnBare: (command) => command === '/resume' || command === '/sessions',
    // No `context` rows: the legacy CLI's were product modes, and this surface
    // has no mode registry. `@` is paths only.
    context: () => [],
    files: () => fileCandidates.list(),
  };

  const queue = new TurnQueue({
    execute: runTurn,
    onChange: (snapshot) => {
      const busyChanged = busy !== snapshot.busy;
      busy = snapshot.busy;
      if (!finished) {
        if (busyChanged) tui.setBusy(busy);
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
    unsettledRunId = runId;
    const pending = client.cancelAgentRun(runId, reason)
      .then(async () => {
        const record = await client.getAgentRun(runId);
        if (record === null || !['completed', 'cancelled', 'failed'].includes(record.status)) {
          throw new Error('Host has not confirmed that the previous run stopped. Retry after cancellation settles.');
        }
        if (unsettledRunId === runId) unsettledRunId = null;
      })
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
    if (!busy) return;
    cancellationRequested = true;
    queue.pause();
    tui.printNotice('Cancelling run; waiting for Host to stop the worker…');
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
    // The footer's right-hand column. Same facts as the status text above, but
    // split so the model can be right-aligned against the token counters
    // instead of sharing one crowded row with them.
    modelLabel: () => ({
      provider: activeSession.providerId,
      model: activeSession.model || options.model || 'default',
      // pi prints `deepseek-flash • high`; the suffix is the same effort the
      // composer border is painted with, so the two cannot disagree.
      ...(effort === null ? {} : { thinking: effort }),
    }),
    // The composer's border colour: pi's tell for how much thinking the next
    // message will buy. Read through a callback so /effort repaints immediately.
    effort: () => effort,
    // `/settings` moves effort through the TUI; this is how the value reaches
    // the variable the next run is started with. The border is the TUI's, the
    // run's effort is this loop's, and they must not drift apart.
    onEffortChange: (level) => { effort = level; },
    onLocaleChange: (nextLocale) => { locale = nextLocale; },
    // Transcript preferences, seeded from the saved set and moved live by
    // `/settings`. Seed + callback, never re-read: the loop owns `effort` and
    // the TUI owns the rest, and one owner each is what keeps them in step.
    showThinking: effectivePreferences.showThinking,
    expandBlocks: effectivePreferences.expandBlocks,
    showToolResults: effectivePreferences.showToolResults,
    maxInputRows: effectivePreferences.inputRows,
    completionRows: effectivePreferences.completionRows,
    isBusy: () => busy,
    canAnswerPermissions: () => activeRunId !== null && !cancellationRequested,
    onSubmit: (text) => { void handleLine(text); },
    onInterrupt: interrupt,
    onExit: () => close(),
  });

  tui.onPermissionDecision = (requestId, decision, answers?: QuestionAnswers) => {
    if (activeRunId === null || cancellationRequested) return;
    void client.resolvePermissionRequest(requestId, {
      status: decision === 'once' || decision === 'always' ? 'allow' : 'deny',
      decision: decision === 'always' ? 'allow_for_session' : decision === 'once' ? 'allow_once' : 'deny',
      ...(answers === undefined ? {} : { updatedInput: { answers } }),
    }).then((request) => {
      if (request === null && !finished) tui.printError('Permission request is no longer pending.');
    }).catch((error: unknown) => {
      if (!finished) tui.printError('Permission response failed: ' + (error instanceof Error ? error.message : String(error)));
    });
  };

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
        // The queue is idle and every cancellation has settled, so no run can
        // still write to the session: whatever it holds now is final. A
        // session this surface created and never used is a ghost, and this is
        // the last moment where deleting it cannot race a turn.
        await owned?.releaseEmpty(client);
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
    const previousModel = activeSession.model;
    activeSession = selected;
    await resyncEffortForModelChange(previousModel);
    tui.replaceTranscript(await loadSessionMessages(client, selectedId));
    tui.printNotice(`Resumed "${selected.title || 'Untitled session'}".`);
  }

  async function startNewSession(): Promise<void> {
    if (busy || queue.snapshot.pending.length > 0) {
      tui.printError('Wait for the current turn to finish before starting a new session.');
      return;
    }
    const previousModel = activeSession.model;
    activeSession = await createChatSession(client, options);
    // This surface created it, so this surface cleans it up: a `/new` that
    // is never typed into is a ghost of the same kind as the opening one.
    owned?.own(activeSession.id);
    await resyncEffortForModelChange(previousModel);
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
    const previousModel = activeSession.model;
    activeSession = adopted;
    await resyncEffortForModelChange(previousModel);
    sessionRows = (await listWorkspaceSessions(client, activeSession)).map(sessionCompletionItem);
    tui.replaceTranscript(await loadSessionMessages(client, adopted.id));
    tui.printNotice(`Switched to "${adopted.title || 'Untitled session'}" (${adopted.id.slice(0, 8)}).`);
  }

  async function runTurn(prompt: string): Promise<TurnOutcome> {
    if (unsettledRunId !== null) {
      await requestRemoteCancellation(unsettledRunId, 'chat cancellation retry');
      if (unsettledRunId !== null) {
        tui.printError('Previous run is still unconfirmed; no new run was started. Retry after checking the Host log.');
        pendingCancellations.delete(unsettledRunId);
        return 'failed';
      }
    }
    if (finished) return 'cancelled';
    cancellationRequested = false;
    const streamAbort = new AbortController();
    activeStream = streamAbort;
    const runSessionId = activeSession.id;
    const runStartedAt = Date.now();
    let permissionPollTimer: ReturnType<typeof setInterval> | null = null;
    // Pending drafts enter the transcript only when admitted to a Host turn.
    tui.printUser(prompt);
    try {
      const start = await client.startAgentRun({
        sessionId: runSessionId,
        prompt,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options.apiFormat !== undefined ? { apiFormat: options.apiFormat } : {}),
        ...(effort !== null ? { effort } : {}),
        workingDirectory: process.cwd(),
      });
      if (!start.accepted) {
        if (cancellationRequested || finished) return 'cancelled';
        if (!finished) tui.printError('Run refused: ' + start.stage + ' - ' + (start.reason ?? ''));
        return 'failed';
      }
      activeRunId = start.runId;
      let permissionPollInFlight = false;
      let permissionPollErrorReported = false;
      const pollPendingPermissions = async (): Promise<void> => {
        if (permissionPollInFlight || activeRunId !== start.runId || cancellationRequested || finished) return;
        permissionPollInFlight = true;
        try {
          const requests = await client.listPendingPermissionRequests(runSessionId);
          for (const request of requests) {
            if (activeRunId !== start.runId || cancellationRequested || finished) return;
            if (request.status !== 'pending' || request.createdAt < runStartedAt) continue;
            // The worker's own words. The reason and the mode are producer
            // facts — a prompt that says "generic" because the record lost
            // them asks the user a different question than the one the
            // worker asked, and the mode decides which card is shown.
            const mode = request.mode === 'ask_user_question' || request.mode === 'exit_plan_mode'
              ? request.mode
              : 'generic';
            void tui.requestPermissionApproval({
              requestId: request.id,
              toolName: request.toolName,
              toolInput: request.toolInput ?? {},
              reason: request.reason ?? 'This tool is waiting for your approval.',
              ...(request.expiresAt === null ? {} : { expiresAt: request.expiresAt }),
              mode,
              destructive: isDestructiveRequest(request.toolName, request.toolInput),
            });
          }
        } catch (error) {
          if (!permissionPollErrorReported && !finished) {
            permissionPollErrorReported = true;
            tui.printError(
              'Could not check pending permissions: '
              + (error instanceof Error ? error.message : String(error)),
            );
          }
        } finally {
          permissionPollInFlight = false;
        }
      };
      void pollPendingPermissions();
      permissionPollTimer = setInterval(() => { void pollPendingPermissions(); }, 1000);
      permissionPollTimer.unref?.();
      // A turn was started on this session, so it is no longer a session
      // this surface may delete: the worker writes the user's message into
      // the timeline, and a turn cancelled before that leaves the session
      // empty even though the user typed something.
      owned?.markUsed(runSessionId);
      // Interrupt/exit may arrive while the start request is still in flight.
      if (cancellationRequested || finished) {
        await requestRemoteCancellation(start.runId, 'chat interrupted during startup');
        return 'cancelled';
      }
      const stream = new HostEventStream(runSessionId, start.runId);
      // T11 step 1 (coexistence). The run's state is now HELD by RunSession, and
      // the view adapter states the two facts the legacy projector has no case
      // for (`tool.timed_out`, `permission.resolved`). The legacy frames still
      // drive every common event — the render-source switch is step 2 and is
      // not done, so this is additive, not a replacement.
      const runState = new RunSession({ runId: start.runId, sessionId: runSessionId });
      let viewState = createRunSessionView();
      for await (const event of client.watchAgentRunEvents(start.runId, { signal: streamAbort.signal })) {
        if (finished) return 'cancelled';
        const frame = stream.push(event);
        if (frame !== null) tui.push(frame);
        runState.apply(event);
        const projection = projectRunSessionView(viewState, runState.getSnapshot());
        viewState = projection.state;
        for (const gap of projection.frames) tui.push(gap);
      }
      if (cancellationRequested || finished) return 'cancelled';
      const record = await client.getAgentRun(start.runId);
      if (record === null) {
        tui.printError('Run stream closed without a settled record. Pending drafts are paused.');
        return 'failed';
      }
      if (record.status === 'failed') {
        // The REASON, not just the id: a run that fails inside the worker
        // (a refused input binding, a provider auth failure) is only
        // diagnosable from the terminal's error, and "run <id> failed" sent
        // the user to the Host log to find out why.
        const terminal = record.terminal;
        const failure = terminal !== null && terminal.status === 'failed' ? terminal.error : undefined;
        tui.printError(
          'Run ' + start.runId + ' failed.'
          + (failure === undefined
            ? ''
            : ' ' + failure.code + ': ' + failure.message),
        );
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
      if (permissionPollTimer !== null) clearInterval(permissionPollTimer);
      // An aborted SSE read is not a stopped worker. Retain queue admission
      // until the Host cancellation request crosses its settlement barrier.
      if (activeRunId !== null && cancellationRequested) {
        await requestRemoteCancellation(activeRunId, 'chat interrupt');
      }
      if (activeRunId !== null) pendingCancellations.delete(activeRunId);
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
            // `/model` is the case this exists for: per-model defaults are the
            // whole point of `cli.tui.effortByModel`.
            const previousModel = activeSession.model;
            activeSession = outcome.session;
            await resyncEffortForModelChange(previousModel);
            if (!finished) tui.refresh();
          } else if (outcome.kind === 'effort_changed') {
            // Adopt first, persist after: the border must change even if the
            // settings endpoint is unavailable, and a failed write is a
            // preference that does not survive restart — not a lost turn.
            effort = outcome.effort;
            if (!finished) tui.refresh();
            try {
              await client.setSetting(TUI_EFFORT_SETTING, outcome.effort ?? 'auto');
              // Keep the mirror honest: `/settings` writes its own keys, but
              // this one went through the loop, and a model switch that reads
              // a stale global would apply the wrong default.
              savedPreferences = { ...savedPreferences, effort: normalizeEffort(outcome.effort ?? 'auto') };
            } catch (error) {
              if (!finished) {
                tui.printError(
                  'Effort applied for this session but could not be saved: '
                  + (error instanceof Error ? error.message : String(error)),
                );
              }
            }
          }
        }
        else if (name === 'help') {
          tui.printNotice(locale === 'zh' ? '可用命令：' : 'Available commands:');
          for (const section of [...helpSections(locale), ...buildSlashHelpSections(locale)]) {
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
  // The banner is a preference because `duya chat` gets piped into other
  // things, and a line the user cannot switch off is a line they have to
  // strip. The log path is not: it is how a stuck run gets diagnosed, and it
  // only appears when diagnostics were asked for.
  if (savedPreferences.startupBanner) {
    tui.printNotice(`session ${sessionId} · type a message, /resume to switch sessions`);
  }
  if (options.diagnosticsLogPath !== undefined) tui.printNotice('Logs: ' + options.diagnosticsLogPath);
  tui.start();
  await finishedPromise;
  return 0;
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
  const owned = new OwnedSessions();
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
    owned.own(created.id);
  }

  if (options.print !== undefined) {
    try {
      return await chatOnce(client, sessionId, options.print, options);
    } finally {
      // A refused run leaves the session empty; a completed one has the
      // prompt in it. Either way the check is the same.
      await owned.releaseEmpty(client);
    }
  }
  return chatInteractive(client, sessionId, options, owned);
}
