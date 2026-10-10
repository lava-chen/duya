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
import type { ToolRegistry } from '../tool/registry.js';
import type { SessionLogger } from '../utils/sessionLogger.js';
import { createHeadlessRunHost, type HeadlessRunHost } from '../process/headless-run-host.js';
import { getLogger } from '../utils/logger.js';
import { TUIApp } from './ui/TUIApp.js';
import type { LegacyFrame } from './ui/blocks.js';
import {
  executeSlashCommand,
  getSlashCommands,
  initSlashCommands,
  isSlashCommand,
} from './slash-commands.js';
import { COMPACTION_CHECKPOINT_ID_SUFFIX } from '../message/index.js';
import { addMessage, replaceMessages, updateSession } from '../session/db.js';
import { REPL } from './repl.js';

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
  readonly sessionId: string;
  /** Tool count for the start-up line, matching the REPL banner. */
  readonly toolCount?: number;
}

export async function runTuiSession(deps: TuiSessionDeps): Promise<void> {
  const { agent, registry, sessionLogger, model, workspace, sessionId } = deps;

  initSlashCommands();
  const host: HeadlessRunHost = createHeadlessRunHost({ agent, toolRegistry: registry });

  let exiting = false;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const tui = new TUIApp({
    title: 'duya',
    history: loadHistory(),
    statusText: () => `${model || 'default'}  ·  ${workspace}`,
    isBusy: () => busy,
    // See `headless-run-host.ts`: a headless run has no permission responder,
    // so the overlay reports that rather than offering choices that all end
    // the same way.
    canAnswerPermissions: () => false,
    onSubmit: (line) => {
      void handleLine(line);
    },
    onInterrupt: () => {
      agent.interrupt();
      tui.printNotice('Interrupted.');
    },
    onExit: () => {
      finish();
    },
  });

  let busy = false;

  tui.printNotice(`duya agent · model ${model || 'default'}`);
  tui.printNotice(`workspace ${workspace}`);
  if (deps.toolCount !== undefined) tui.printNotice(`${deps.toolCount} tools available`);

  /**
   * One turn. Streams frames into the TUI and mirrors the REPL path's
   * persistence so both surfaces leave the same rows in the database.
   */
  async function runTurn(prompt: string): Promise<void> {
    busy = true;
    tui.setBusy(true);

    const userMessageId = crypto.randomUUID();
    let assistantText = '';
    // Authoritative-on-block, exactly as the block model does it: deltas
    // accumulate, and the whole-block frame REPLACES rather than appends.
    // Concatenating both prints every answer twice.
    let deltaBuffer = '';

    try {
      const run = await host.start({
        prompt,
        sessionId,
        cwd: workspace,
        model: model || '',
        providerId: 'cli',
      });

      for await (const frame of run.frames()) {
        tui.push(frame as LegacyFrame);
        if (frame.type === 'text_delta') {
          deltaBuffer += readContent(frame);
        } else if (frame.type === 'text') {
          assistantText = readContent(frame);
        }
      }

      if (assistantText === '') assistantText = deltaBuffer;

      // The REPL path persists on the same boundary.
      const allMessages = agent.getMessages();
      const userMessage = allMessages.find((m) => m.role === 'user');
      if (userMessage !== undefined && !allMessages.some((m) => m.id === userMessageId)) {
        addMessage({
          id: userMessageId,
          session_id: sessionId,
          role: 'user',
          content: prompt,
        });
      }
      if (assistantText !== '') {
        addMessage({
          id: crypto.randomUUID(),
          session_id: sessionId,
          role: 'assistant',
          content: assistantText,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tui.printError(message);
      sessionLogger.logError(error instanceof Error ? error : String(error));
    } finally {
      busy = false;
      tui.setBusy(false);
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
        tui.printNotice(`/${cmd.name}  ${cmd.description ?? ''}`);
      }
      return;
    }

    if (isSlashCommand(trimmed)) {
      const handled = await executeSlashCommand(trimmed, {
        agent,
        sessionId,
        platform: 'cli',
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

    sessionLogger.logUser(trimmed);
    await runTurn(trimmed);
  }

  function finish(): void {
    if (exiting) return;
    exiting = true;
    try {
      // Same projection filter the REPL applies: a standalone copy of a
      // compaction checkpoint marker collides with the rebase-emitted id.
      const allMessages = agent.getMessages();
      const persistable = allMessages.filter(
        (m) => !(m.id ?? '').endsWith(COMPACTION_CHECKPOINT_ID_SUFFIX),
      );
      if (persistable.length > 0) {
        void replaceMessages(sessionId, persistable, 0);
      }
      const firstUser = allMessages.find((m) => m.role === 'user');
      if (firstUser !== undefined) {
        updateSession(sessionId, {
          title: typeof firstUser.content === 'string' ? firstUser.content.slice(0, 50) : 'Chat',
        });
      }
    } finally {
      saveHistory(tui.exportHistory());
      tui.stop();
      // After the screen is gone, later output must reach the real terminal.
      restoreSideChannels();
      resolveExit();
    }
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

/** Read `data.content` from a frame, tolerating both wire shapes. */
function readContent(frame: LegacyFrame): string {
  const { data } = frame;
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null) {
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}
