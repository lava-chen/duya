/**
 * The TUI session: `runInteractive`'s counterpart when the process has a
 * terminal on both ends.
 *
 * ## What this reuses, and what it cannot
 *
 * The REPL path in `cli/index.ts` and this file share the run layer, the
 * slash-command registry and the session-logger calls, because those are
 * facts about the agent rather than about the terminal. What they do NOT
 * share is rendering, and that split is the whole point: the REPL prints to
 * stdout, while this feeds `LegacySseFrame`s into `TUIApp`, whose block model
 * decides what a line looks like.
 *
 * ## Two adaptations the terminal forces
 *
 * 1. **Console capture.** Slash commands report through `console.log`.
 *    Inside an alternate-screen app that writes straight through the rendered
 *    frame and garbles it, so console output is redirected into transcript
 *    blocks for the duration of the command.
 * 2. **`/` alone does not open the picker.** `showSlashCommandMenu` drives
 *    an inquirer `select`, which claims stdin in raw mode and fights the TUI
 *    for it. The TUI lists the commands as transcript lines instead. Every
 *    individual `/command` still works — the picker is only the discovery
 *    affordance.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { format } from 'node:util';
import type { duyaAgent } from '../agent/DuyaAgent.js';
import type { Message, ChatOptions } from '../types.js';
import type { ToolRegistry } from '../tool/registry.js';
import type { HostRunApiV1 } from '@duya/agent-protocol';
import type { CliHostSession } from '@duya/cli/host-session';
import type { CliTranscriptPersistence } from '@duya/cli/transcript-persistence';
import type { SessionLogger } from '../utils/sessionLogger.js';
import { createHeadlessRunHost, type HeadlessRunHost } from '../process/headless-run-host.js';
import { getLogger } from '../utils/logger.js';
import { TUIApp, isDestructiveRequest, runProviderLogin, type LegacyFrame } from '@duya/cli/tui';
import type { PopoverItem } from '@duya/input-completion';
import { defaultCompletionSources } from './ui/candidates.js';
import {
  executeSlashCommand,
  getSlashCommands,
  initSlashCommands,
  isSlashCommand,
} from './slash-commands.js';
import { REPL } from './repl.js';
import { resolveProvider } from './config/file-config.js';
import { BUILTIN_CATALOG, findModelById } from '@duya/ai';

/** Where the input history lives, matching the REPL's own path. */
function historyFilePath(): string {
  return path.join(homedir(), '.duya', '.cli_history');
}

function loadHistory(): string[] {
  try {
    const file = historyFilePath();
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    // A missing or unreadable history is not a reason to refuse to start.
    return [];
  }
}

function saveHistory(entries: readonly string[]): void {
  try {
    const file = historyFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.slice(-1000).join('\n'), 'utf-8');
  } catch {
    // Losing the history is a far smaller failure than refusing to exit.
  }
}

/**
 * Route console output into the transcript for as long as the TUI owns the
 * screen, and return the undo.
 *
 * ## Why this spans the whole session, not just the slash commands
 *
 * An alternate-screen app owns the terminal. ANY byte written to stdout while
 * the screen is up lands on top of the rendered frame and corrupts it. That
 * includes logging, not just user-facing output: the agent logger defaults to
 * INFO (`packages/agent/src/utils/logger.ts`), so every turn emits dozens of
 * `[INFO] [Agent] streamChat: ...` lines, and `packages/ai` has its own
 * unconditional `console.warn` diagnostic that it cannot route through the
 * agent logger.
 *
 * The previous version wrapped only the two slash-command call sites, which is
 * why the frame looked fine until a turn started and then fell apart.
 *
 * The swap is still undone explicitly rather than left installed: once the
 * screen is destroyed, later output must reach the real terminal, and a
 * redirect left behind would silently swallow it.
 */
/**
 * The slice of `TUIApp` that console capture needs.
 *
 * Narrower than the class on purpose: the capture is a pure redirect, and
 * requiring the whole blessed app to test it would mean standing up a terminal
 * to assert something that has no terminal in it.
 */
export interface ConsoleSink {
  printNotice(text: string): void;
  printError(text: string): void;
}

export function installConsoleCapture(tui: ConsoleSink): () => void {
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };

  // `util.format`, not `args.map(String).join(' ')`: the structured diagnostics
  // this has to absorb pass an OBJECT as the last argument, and String(obj)
  // reduces a whole dump to the literal text "[object Object]".
  const notice = (...args: unknown[]): void => {
    tui.printNotice(format(...args));
  };
  const failure = (...args: unknown[]): void => {
    tui.printError(format(...args));
  };

  console.log = notice;
  console.warn = notice;
  console.debug = notice;
  console.error = failure;

  return () => {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    console.debug = original.debug;
  };
}

export interface TuiSessionDeps {
  readonly agent: duyaAgent;
  readonly registry: ToolRegistry;
  readonly sessionLogger: SessionLogger;
  readonly model: string;
  readonly workspace: string;
  readonly session: CliHostSession;
  readonly runApi: HostRunApiV1;
  readonly persistMessages: CliTranscriptPersistence;
  /** Tool count for the start-up line, matching the REPL banner. */
  readonly toolCount?: number;
}

/**
 * The TUI's picker decision → the executor's verdict.
 *
 * Exported because the mapping IS the contract of the ask chain: an allow is
 * an allow, and EVERYTHING else — deny, Esc, a deadline — is a refusal.
 * `'paused'` is deliberately not produced: that verdict exists for the bot
 * surface, where the turn ends and a later card answers; the CLI user is
 * present, so their "no" (or their silence) is answered now.
 */
export function mapPermissionDecision(decision: 'once' | 'always' | 'deny' | null): 'allow' | 'deny' {
  return decision === 'once' || decision === 'always' ? 'allow' : 'deny';
}

export async function runTuiSession(deps: TuiSessionDeps): Promise<void> {
  const { agent, registry, sessionLogger, model, workspace } = deps;

  initSlashCommands();
  // The ask chain (plan 611 P0-2): the executor raises a tool ask through
  // `ChatOptions.requestPermission`, this handler routes it to the TUI's
  // permission queue (codex-style list picker), and the user's answer rides
  // back as the verdict. `null` — Esc, or the request's own deadline — maps
  // to a refusal, NEVER to an allow: an unanswered prompt must not approve a
  // tool call by accident.
  const requestPermission: ChatOptions['requestPermission'] = async (request) => {
    const decision = await tui.requestPermissionApproval({
      requestId: request.id,
      toolName: request.toolName,
      toolInput: request.toolInput,
      reason: request.decisionReason ?? '',
      mode: request.mode,
      expiresAt: request.expiresAt,
      destructive: isDestructiveRequest(request.toolName, request.toolInput),
    });
    return mapPermissionDecision(decision);
  };
  const host: HeadlessRunHost = createHeadlessRunHost({
    agent,
    toolRegistry: registry,
    runApi: deps.runApi,
    requestPermission,
  });
  const configuredModels = (() => {
    const resolution = resolveProvider();
    return resolution.ok ? resolution.provider.models : [];
  })();
  const slashOptions = new Map<string, PopoverItem[]>(
    getSlashCommands().map((command): [string, PopoverItem[]] => [
      `/${command.name}`,
      (command.subcommands ?? []).map((value) => ({
        label: command.name === 'login'
          ? value === 'add' ? '添加服务商' : '管理已配置服务商'
          : value,
        value,
        description: command.name === 'login'
          ? value === 'add' ? '从 Duya 服务商目录注册并录入密钥' : '设为默认或移除 Desktop 服务商'
          : '',
        kind: 'slash_command' as const,
        category: 'command' as const,
        group: 'settings' as const,
      })),
    ] as const),
  );

  let exiting = false;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const tui = new TUIApp({
    title: 'duya',
    history: loadHistory(),
    completionSources: {
      ...defaultCompletionSources(workspace),
      slashOptions: (command) => {
        if (command === '/model') {
          const current = agent.model || model;
          const choices = [...new Set([current, ...configuredModels].filter(Boolean))];
          return choices.map((value) => ({
            label: value,
            value,
            description: value === current ? 'current' : '',
            kind: 'slash_command' as const,
            category: 'command' as const,
            group: 'settings' as const,
          }));
        }
        return slashOptions.get(command.toLowerCase()) ?? [];
      },
      slashOptionsOnBare: (command) => command === '/model' || command === '/login',
    },
    statusText: () => [agent.model || model || 'default', workspace].join('  ·  '),
    isBusy: () => busy,
    // The context-window budget for the active model, when the catalog knows
    // it; unknown ids (custom providers) fall back to the bare session total.
    contextBudgetTokens: () => {
      const id = agent.model || model || '';
      if (id === '') return null;
      return findModelById(id)?.contextWindow ?? null;
    },
    // The ask chain is wired above: the host carries a `requestPermission`
    // callback, so the overlay offers real choices and every answer reaches
    // the executor's pending tool promise.
    canAnswerPermissions: () => true,
    // The busy-time queue's visible half: the status bar's `⧗ N` segment.
    queuedCount: () => queuedPrompts.length,
    onSubmit: (line) => {
      void handleLine(line);
    },
    onInterrupt: () => {
      // Steering semantics (plan 611 P1-a, codex model): the queued prompts
      // SURVIVE an interrupt. The head queued prompt is exactly what the user
      // wants the NEXT turn to do — killing the run does not kill the
      // instruction — so `runTurn`'s finally drains it into a fresh turn
      // right after the abort settles. `/exit` still ends everything, and a
      // user who wants a truly empty queue can clear it by exiting.
      agent.interrupt();
      const pending = queuedPrompts.length;
      tui.printNotice(pending > 0
        ? `Interrupted. ${pending} queued prompt${pending === 1 ? '' : 's'} will steer the next turn.`
        : 'Interrupted.');
    },
    onExit: () => {
      finish();
    },
  });

  let busy = false;
  /**
   * Prompts submitted while a turn is running.
   *
   * Without this, a second submit while the agent works would start a SECOND
   * concurrent run against the same session — two turns interleaving their
   * frames into one transcript. Queued prompts drain in order from
   * `runTurn`'s `finally`.
   */
  const queuedPrompts: string[] = [];

  tui.printNotice(`duya agent · model ${model || 'default'}`);
  tui.printNotice(`workspace ${workspace}`);
  if (deps.toolCount !== undefined) tui.printNotice(`${deps.toolCount} tools available`);

  /** One turn. The Host persistence callback records the completed transcript. */
  async function runTurn(prompt: string): Promise<void> {
    busy = true;
    tui.setBusy(true);

    try {
      const run = await host.start({
        prompt,
        sessionId: deps.session.id,
        cwd: workspace,
        model: agent.model || deps.session.model || model || '',
        providerId: deps.session.providerId,
      });

      for await (const frame of run.frames()) {
        tui.push(frame as LegacyFrame);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tui.printError(message);
      sessionLogger.logError(error instanceof Error ? error : String(error));
    } finally {
      try {
        await deps.persistMessages(agent.getMessages());
      } catch (error) {
        tui.printError(`Could not save the session: ${error instanceof Error ? error.message : String(error)}`);
        sessionLogger.logError(error instanceof Error ? error : String(error));
        process.exitCode = 1;
      }
      busy = false;
      tui.setBusy(false);
      // Drain the queue AFTER the state flips: a `queueMicrotask` re-entry
      // sees `busy === false` and starts the next turn instead of re-queuing.
      const next = queuedPrompts.shift();
      if (next !== undefined) {
        tui.printNotice('running queued prompt');
        queueMicrotask(() => {
          void handleLine(next);
        });
      }
    }
  }

  /** Dispatch one submitted line: slash command first, otherwise a turn. */
  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') return;

    // `/` alone would open an inquirer picker that claims stdin in raw mode
    // and fights the TUI for it. List the commands instead.
    if (trimmed === '/') {
      for (const cmd of getSlashCommands()) {
        const aliases = cmd.aliases?.length ? ` (alias: ${cmd.aliases.map((alias) => `/${alias}`).join(', ')})` : '';
        tui.printNotice(`/${cmd.name}${aliases}  ${cmd.description ?? ''}`);
      }
      return;
    }

    if (isSlashCommand(trimmed)) {
      const handled = await executeSlashCommand(trimmed, {
        agent,
        sessionId: deps.session.id,
        platform: 'cli',
        updateSessionModel: (nextModel) => deps.session.updateModel(nextModel),
        resumeSession: async (query) => {
          if (busy) {
            tui.printError('Wait for the current task to finish before switching sessions.');
            return;
          }
          try {
            const sessions = await deps.session.listSessions();
            const choices = sessions.map(({ session, timelineCount }) => ({
              label: [
                session.title || 'Untitled session',
                `${session.providerId}/${session.model || 'default'}`,
                `${timelineCount} messages`,
                new Date(session.updatedAt).toLocaleString(),
                session.id.slice(0, 8),
              ].join('  ·  '),
              value: session.id,
            }));
            if (choices.length === 0) {
              tui.printNotice('No previous sessions in this workspace.');
              return;
            }
            const selectedId = await tui.chooseFiltered('Resume session', choices, {
              initialFilter: query,
            });
            if (selectedId === null) return;
            if (busy) {
              tui.printError('The active task started before the session could be switched.');
              return;
            }

            const loaded = await deps.session.loadSession(selectedId);
            const activeProviderId = deps.session.providerId;
            if (
              loaded.session.providerId !== activeProviderId
              && loaded.session.providerId !== 'cli'
              && activeProviderId !== 'cli'
            ) {
              tui.printError(
                `This session uses provider "${loaded.session.providerId}"; `
                + `the active CLI agent uses "${activeProviderId}". Switch providers before resuming it.`,
              );
              return;
            }

            agent.setMessages(loaded.messages as unknown as Message[]);
            agent.model = loaded.session.model || model;
            deps.session.activateSession(loaded.session);
            deps.persistMessages.setBaseline(loaded.messages);
            tui.replaceTranscript(loaded.messages);
            tui.printNotice(
              `Resumed "${loaded.session.title || 'Untitled session'}" `
              + `(${loaded.session.providerId}/${loaded.session.model || 'default'}).`,
            );
          } catch (error) {
            tui.printError(`Could not resume session: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
        providerLogin: async (action) => {
          if (busy) {
            tui.printError('Wait for the current task to finish before managing providers.');
            return;
          }
          await runProviderLogin(tui, action, BUILTIN_CATALOG.list());
        },
      });
      if (handled && (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q')) {
        finish();
      }
      return;
    }

    // `/log` is not in the registry; it is handled by the REPL directly.
    if (trimmed === '/log' || trimmed.startsWith('/log ')) {
      const filename = trimmed.split(/\s+/)[1];
      const logDir = sessionLogger.getLogDirectory?.() || process.cwd();
      // Reuse the REPL's own reader so both surfaces show the same thing.
      const reader = new REPL({ onLine: () => {} });
      reader.showLogs(logDir, filename);
      return;
    }

    // A turn is running and this is not a slash command: queue it rather than
    // starting a second concurrent run against the same session. Slash
    // commands stay immediate — `/status`, `/effort` and friends are useful
    // mid-run, which is exactly when people reach for them.
    if (busy) {
      queuedPrompts.push(trimmed);
      tui.printNotice(`queued (${queuedPrompts.length}) — it will run when the current turn finishes`);
      return;
    }

    sessionLogger.logUser(trimmed);
    await runTurn(trimmed);
  }

  let finishPromise: Promise<void> | null = null;

  function finish(): void {
    if (finishPromise) return;
    exiting = true;
    finishPromise = (async () => {
      try {
        await deps.persistMessages(agent.getMessages());
      } catch (error) {
        tui.printError(`Could not save the session: ${error instanceof Error ? error.message : String(error)}`);
        sessionLogger.logError(error instanceof Error ? error : String(error));
        process.exitCode = 1;
      } finally {
        saveHistory(tui.exportHistory());
        tui.stop();
        // After the screen is gone, later output must reach the real terminal.
        restoreSideChannels();
        resolveExit();
      }
    })();
  }

  // From here until `finish()`, the alternate screen owns stdout. Logging is
  // captured, so it lands in the transcript rather than on top of the frame.
  const restoreConsole = installConsoleCapture(tui);

  // The agent logger defaults to INFO. Captured, that is dozens of transcript
  // lines per turn, so the session runs at the level AGENTS.md documents as the
  // default (WARN). Every line still reaches the log file either way.
  const agentLogger = getLogger();
  const previousLevel = agentLogger.getConfig().level;
  agentLogger.updateConfig({ level: 'WARN' });

  function restoreSideChannels(): void {
    restoreConsole();
    agentLogger.updateConfig({ level: previousLevel });
  }

  tui.start();

  await Promise.race([exited, interruptSignal(agent)]);

  // Whichever way the session ended, tear down once.
  finish();
}

/** Resolves if the agent is interrupted from outside the TUI's own key path. */
function interruptSignal(agent: duyaAgent): Promise<void> {
  return new Promise<void>((resolve) => {
    const anyAgent = agent as unknown as { once?: (e: string, cb: () => void) => void };
    if (typeof anyAgent.once !== 'function') return;
    anyAgent.once('interrupt', () => resolve());
  });
}
