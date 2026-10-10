/**
 * duya Agent CLI - Main Entry Point
 *
 * A standalone CLI interface for the duya Agent that can run independently
 * of the main duya application.
 *
 * Modes:
 * - Interactive (default): REPL interface
 * - Print: duya print "prompt" - single query mode
 * - Headless: duya headless --script ./task.txt
 * - Task: duya -t "prompt" - single task and exit
 * - Session: duya session list|continue|delete
 * - Provider: duya provider list|add|remove
 * - Config: duya config show|init
 * - MCP: duya mcp list|check|remove
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Command } from '@commander-js/extra-typings';
import { readTextContent, type LegacySseFrame } from '@duya/agent-runtime';
import { duyaAgent } from '../agent/DuyaAgent.js';
import { createHeadlessRunHost, type HeadlessRunHost } from '../process/headless-run-host.js';
import { COMPACTION_CHECKPOINT_ID_SUFFIX } from '../message/index.js';
import { createBuiltinRegistry } from '../tool/builtin.js';
import { sessionSearchTool, type SummaryLLMConfig } from '../tool/SessionSearchTool/index.js';
import type { AgentOptions, Message } from '../types.js';
import type { ToolRegistry } from '../tool/registry.js';
import type { SubagentRunDeps } from '../tool/SubagentTool/runAgent.js';
import { loadSkills, getSkillRegistry } from '../skills/index.js';
import { Colors, color } from './colors.js';
import { REPL } from './repl.js';
import { shouldUseTui } from './ui/tty.js';
import { runTuiSession } from './tui-session.js';
import {
  initSessionLogger,
  closeSessionLogger,
  getGlobalSessionLogger,
  type SessionLogger,
} from '../utils/sessionLogger.js';
import { printWelcomeBanner } from './banner.js';
import { listSessions, selectSession } from './sessionCmds.js';
import type { SessionInfo } from './sessionCmds.js';
import {
  createSession,
  addMessage,
  replaceMessages,
  updateSession,
  type ChatSession,
} from '../session/db.js';
import { listProviders, addProviderInteractive } from './providerCmds.js';
import { listMCPServers } from './mcpCmds.js';
import { printSuccess, printError, printHeader, printInfo } from './interactive.js';
import { getCliSetting, getCliSettingJson } from './config/db-config.js';
import { createAgentProgram, parseCliArgs } from './cli-program.js';
import { resolveProvider, readCliSettings, type ProviderResolution } from './config/file-config.js';
import {
  initSlashCommands,
  executeSlashCommand,
  showSlashCommandMenu,
  isSlashCommand,
  getSlashCommands,
} from './slash-commands.js';
// (Plan 99: the desktop control plane — status / plugin / session /
// skill / mcp / provider / channel / cron / message / install-cli —
// now lives in @duya/cli. See packages/cli/src/. The agent runtime
// only owns the REPL/print/headless modes, the legacy `config show`,
// and the legacy `setup` wizard.)

/**
 * Load .env file into process.env
 */
function loadEnv(): void {
  // Try multiple locations for .env file
  const possiblePaths = [
    join(process.cwd(), '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '.env'),
  ];

  for (const envPath of possiblePaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex);
            const value = trimmed.slice(eqIndex + 1);
            if (!process.env[key]) {
              process.env[key] = value;
            }
          }
        }
      }
      break;
    }
  }
}

// Load .env file on startup
loadEnv();

export interface CLIOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /**
   * Wire protocol override (`-p/--provider`). Distinct from the config.toml
   * `providerType` vocabulary; see `mapProviderType`.
   */
  provider?: string;
  workspace?: string;
  task?: string;
  mode?: 'interactive' | 'print' | 'headless';
  scriptPath?: string;
  format?: 'text' | 'json' | 'markdown';
  summaryLLMProvider?: 'anthropic' | 'openai';
  summaryLLMApiKey?: string;
  summaryLLMModel?: string;
  summaryLLMBaseUrl?: string;
}

/**
 * Print the welcome banner (legacy function - now uses banner.ts)
 */
function printBanner(): void {
  printWelcomeBanner({
    model: process.env.ANTHROPIC_MODEL || '',
    workspace: process.cwd(),
    toolCount: 0,
    skillCount: 0,
    mcpServers: [],
  })
}

/**
 * Print session information
 */
function printSessionInfo(model: string, workspace: string, messageCount: number): void {
  const contentWidth = 42;
  const labelModel = 'Model: ';
  const labelWorkspace = 'Workspace: ';
  const labelMessages = 'Messages: ';

  const modelContent = `${labelModel}${model}`;
  const workspaceContent = `${labelWorkspace}${workspace}`;
  const messagesContent = `${labelMessages}${messageCount}`;

  const modelPadding = Math.max(0, contentWidth - modelContent.length);
  const workspacePadding = Math.max(0, contentWidth - workspaceContent.length);
  const messagesPadding = Math.max(0, contentWidth - messagesContent.length);

  const hBorder = '─'.repeat(contentWidth + 2);

  console.log(`
${Colors.DIM}┌${hBorder}┐${Colors.RESET}
${Colors.DIM}│${Colors.RESET}  ${Colors.BRIGHT_CYAN}Session Info${' '.repeat(contentWidth - 12)}${Colors.DIM}│${Colors.RESET}
${Colors.DIM}├${hBorder}┤${Colors.RESET}
${Colors.DIM}│${Colors.RESET}  ${Colors.BRIGHT_GREEN}${modelContent}${Colors.RESET}${' '.repeat(modelPadding)}${Colors.DIM}│${Colors.RESET}
${Colors.DIM}│${Colors.RESET}  ${Colors.BRIGHT_YELLOW}${workspaceContent}${Colors.RESET}${' '.repeat(workspacePadding)}${Colors.DIM}│${Colors.RESET}
${Colors.DIM}│${Colors.RESET}  ${messagesContent}${' '.repeat(messagesPadding)}${Colors.DIM}│${Colors.RESET}
${Colors.DIM}└${hBorder}┘${Colors.RESET}
`);
}

/**
 * Strip HTML tags from a string
 */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

/**
 * Build a compact preview of a tool call's primary argument
 */
function buildToolPreview(toolName: string, args: Record<string, unknown>): string {
  const primaryArgs: Record<string, string> = {
    terminal: 'command',
    web_search: 'query',
    web_extract: 'urls',
    read_file: 'path',
    write_file: 'path',
    patch: 'path',
    search_files: 'pattern',
    browser_navigate: 'url',
    browser_click: 'ref',
    browser_type: 'text',
    image_generate: 'prompt',
    text_to_speech: 'text',
    vision_analyze: 'question',
    skill_view: 'name',
    skills_list: 'category',
    execute_code: 'code',
    delegate_task: 'goal',
    clarify: 'question',
    todo: 'todos',
    memory: 'action',
    session_search: 'query',
  };

  const key = primaryArgs[toolName];
  if (key && args[key]) {
    const value = String(args[key]);
    if (value.length > 40) {
      return value.slice(0, 37) + '...';
    }
    return value;
  }

  // Fallback: use first string argument
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 0) {
      if (v.length > 40) {
        return v.slice(0, 37) + '...';
      }
      return v;
    }
  }

  return '';
}

/**
 * Get display mode from settings
 */
function getToolDisplayMode(): 'verbose' | 'compact' {
  return (getCliSetting('tool_display_mode') as 'verbose' | 'compact') || 'verbose';
}

/**
 * Handle the run's legacy frames and print formatted output.
 *
 * ## What changed in H8.1, and why it is not cosmetic
 *
 * This used to take `agent.streamChat(prompt)` — the agent's own SSE union,
 * straight from the executor, with no run around it. That is the shape R2.1's
 * census recorded as a DIVERGENCE: the CLI was a second run loop, deciding for
 * itself when a turn was over and what its terminal was.
 *
 * It now takes the run's LEGACY FRAMES, produced by the runtime's own projector
 * from the run's own events. So the strings printed below are the same strings
 * the Desktop renderer prints, derived from the same run, numbered by the same
 * ledger. The CLI's job is unchanged — it renders — but the thing it renders is
 * now the run layer's output rather than a private stream it happened to own.
 *
 * `readTextContent` rather than a bare `data` read, because `text` arrives as
 * `{ content }` on this path where it arrived as a bare string on the old one.
 * The runtime ships that reader for exactly this two-shape situation.
 */
async function handleStreamEvents(
  agent: duyaAgent,
  frames: AsyncGenerator<LegacySseFrame, void, unknown>,
  sessionLogger: SessionLogger,
  sessionId?: string,
  userMessageId?: string
): Promise<void> {
  let currentText = '';
  let thinkingBuffer = '';
  let stepToolCount = 0;
  let userMessageIdSent = false;
  let assistantMessageId = crypto.randomUUID();
  const displayMode = getToolDisplayMode();
  const isCompact = displayMode === 'compact';

  for await (const frame of frames) {
    // A LOCAL view over the frame, not a cast to `SSEEvent`.
    //
    // The switch narrows on `frame.type` (a plain `string`), so casting the
    // frame to the agent's declared union would not narrow at all — the union's
    // discriminant would be the cast's, not the switch's. Reading through one
    // shape keeps every field access total and keeps the switch the single
    // place that decides what a frame means.
    const payload = (typeof frame.data === 'object' && frame.data !== null
      ? frame.data
      : {}) as Readonly<Record<string, unknown>>;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    switch (frame.type) {
      case 'text':
        currentText += readTextContent(frame);
        break;

      case 'thinking':
        // Signature-only events carry empty data — don't clobber the buffer.
        if (readTextContent(frame)) {
          thinkingBuffer = readTextContent(frame);
        }
        break;

      case 'tool_use': {
        if (currentText) {
          console.log(currentText);
          currentText = '';
        }
        stepToolCount++;
        const name = str(payload['name']);
        // Narrowed to a record, not asserted: a frame whose `input` is a bare
        // string is a frame the tool never sent, and an empty record is the
        // honest reading of it (the preview then finds no key and returns '').
        const input =
          typeof payload['input'] === 'object' && payload['input'] !== null && !Array.isArray(payload['input'])
            ? (payload['input'] as Record<string, unknown>)
            : {};

        if (isCompact) {
          // Compact mode: show tool name with preview only
          const preview = buildToolPreview(name, input);
          if (preview) {
            console.log(`${Colors.DIM}  → ${name}: ${preview}${Colors.RESET}`);
          } else {
            console.log(`${Colors.DIM}  → ${name}${Colors.RESET}`);
          }
        } else {
          // Verbose mode: show full tool call details
          console.log(`\n${Colors.BRIGHT_YELLOW}${Colors.TOOL} Tool Call:${Colors.RESET} ${Colors.BOLD}${Colors.CYAN}${name}${Colors.RESET}`);
          console.log(`${Colors.DIM}   Arguments:${Colors.RESET}`);
          try {
            const argsJson = JSON.stringify(input, null, 2);
            const lines = argsJson.split('\n');
            for (const line of lines) {
              console.log(`   ${Colors.DIM}${line}${Colors.RESET}`);
            }
          } catch {
            console.log(`   ${Colors.DIM}${JSON.stringify(input)}${Colors.RESET}`);
          }
        }
        // Log tool use
        sessionLogger.logTool(name, input);
        break;
      }

      case 'tool_result': {
        if (currentText) {
          console.log(currentText);
          currentText = '';
        }
        const result = str(payload['result']);
        if (payload['error']) {
          if (isCompact) {
            console.log(`${Colors.DIM}    ${Colors.RED}✗ Error${Colors.RESET}`);
          } else {
            console.log(`${Colors.BRIGHT_RED}${Colors.ERROR} Error:${Colors.RESET} ${Colors.RED}${result}${Colors.RESET}`);
          }
        } else {
          if (isCompact) {
            // Compact mode: show success indicator with truncated result
            const shown = result.length > 60 ? result.slice(0, 57) + '...' : result;
            console.log(`${Colors.DIM}    ${Colors.GREEN}✓${Colors.RESET} ${Colors.DIM}${shown}${Colors.RESET}`);
          } else {
            // Verbose mode: show full result
            const shown = result.length > 300 ? result.slice(0, 300) + `${Colors.DIM}...${Colors.RESET}` : result;
            console.log(`${Colors.BRIGHT_GREEN}${Colors.SUCCESS} Result:${Colors.RESET} ${shown}`);
          }
        }
        break;
      }

      case 'tool_progress':
        break;

      case 'tool_timeout':
        if (isCompact) {
          console.log(`${Colors.DIM}    ${Colors.YELLOW}⏱ timeout (${str(payload['elapsedSeconds'])}s)${Colors.RESET}`);
        } else {
          console.log(`${Colors.BRIGHT_YELLOW}${Colors.TIMEOUT} Tool timed out: ${str(payload['toolName'])} (${str(payload['elapsedSeconds'])}s)${Colors.RESET}`);
        }
        break;

      case 'error': {
        // `run.failed` projects to `{ message, code }`, where the agent's own
        // `error` event carried a bare string. Read the field rather than
        // interpolating the object, so the CLI prints the sentence and not
        // `[object Object]`.
        const message =
          typeof frame.data === 'object' && frame.data !== null
            ? String((frame.data as { message?: unknown }).message ?? '')
            : String(frame.data ?? '');
        console.error(`${Colors.BRIGHT_RED}${Colors.ERROR} Error:${Colors.RESET} ${message}`);
        sessionLogger.logError(message);
        break;
      }

      // The agent's raw usage event was `result`; the runtime projects
      // `assistant.usage` to `token_usage`, which is the name the wire uses
      // everywhere else. Accepting only the new name is deliberate: a silent
      // fallback to `result` would be a second vocabulary, which is the thing
      // H8.1 exists to remove.
      case 'token_usage': {
        const total = (frame.data as { total_tokens?: number } | undefined)?.total_tokens;
        if (total) {
          console.log(`${Colors.DIM}Token usage: ${total}${Colors.RESET}`);
        }
        break;
      }

      case 'done':
        if (currentText) {
          // Log assistant response
          sessionLogger.logAssistant(currentText);
          console.log(currentText);

          // Persist messages if sessionId is provided (interactive mode)
          if (sessionId && userMessageId) {
            // Persist user message if not already done
            if (!userMessageIdSent) {
              const userMsg = agent.getMessages().find((m) => m.id === userMessageId);
              if (!userMsg) {
                // User message wasn't persisted yet, do it now
                addMessage({
                  id: userMessageId,
                  session_id: sessionId,
                  role: 'user',
                  content: agent.getMessages().find((m) => m.role === 'user')?.content?.toString() || '',
                });
              }
              userMessageIdSent = true;
            }

            // Persist assistant message
            addMessage({
              id: assistantMessageId,
              session_id: sessionId,
              role: 'assistant',
              content: currentText,
            });
          }

          currentText = '';
        }
        if (thinkingBuffer) {
          const cleanThinking = stripHtmlTags(thinkingBuffer);
          if (isCompact) {
            // Compact mode: show thinking in a more condensed format
            const lines = cleanThinking.split('\n').filter(line => line.trim());
            if (lines.length > 0) {
              console.log(`\n${Colors.DIM}  💭 ${lines[0].slice(0, 60)}${lines[0].length > 60 ? '...' : ''}${Colors.RESET}`);
              if (lines.length > 1) {
                console.log(`${Colors.DIM}     (${lines.length - 1} more lines)${Colors.RESET}`);
              }
            }
          } else {
            // Verbose mode: show full thinking
            console.log(`\n${Colors.BOLD}${Colors.MAGENTA}${Colors.THINKING} Thinking:${Colors.RESET}`);
            console.log(`${Colors.DIM}${cleanThinking}${Colors.RESET}`);
          }
          thinkingBuffer = '';
        }
        if (stepToolCount > 0) {
          if (isCompact) {
            console.log(`${Colors.DIM}  (${stepToolCount} tool call${stepToolCount > 1 ? 's' : ''})${Colors.RESET}`);
          } else {
            console.log(`${Colors.DIM}⏱  ${stepToolCount} tool(s) executed${Colors.RESET}`);
          }
          stepToolCount = 0;
        }
        break;
    }
  }
}

/**
 * Run the agent in interactive mode with session persistence
 */
async function runInteractive(
  agent: duyaAgent,
  registry: ToolRegistry,
  sessionLogger: SessionLogger,
  model: string,
  workspace: string
): Promise<void> {
  // Create a new session in the database
  const sessionId = crypto.randomUUID();
  const session = createSession({
    id: sessionId,
    title: 'New Chat',
    model,
    working_directory: workspace,
    mode: 'code',
    status: 'active',
  });
  console.log(`${Colors.DIM}Session created: ${sessionId.slice(0, 8)}...${Colors.RESET}`);

  // Interactive mode has two surfaces, chosen BEFORE anything is constructed.
  //
  // `blessed.screen()` claims the terminal when it is created: with stdout
  // piped it writes cursor and erase-screen sequences into that pipe
  // (measured on blessed 0.1.81 — `ESC[1;1H ESC[H ESC[J`), which corrupts the
  // output of anything reading it. So the TUI is only constructed when BOTH
  // ends are a terminal, and everything else falls through to the REPL below,
  // which already handles terminal readline, persisted history and
  // completion.
  if (shouldUseTui()) {
    return runTuiSession({
      agent,
      registry,
      sessionLogger,
      model,
      workspace,
      sessionId,
      toolCount: registry.size,
    });
  }

  // The run host, built once for the REPL's lifetime (plan 587 H8.1). The
  // controller is stateless between runs, so this is a composition rather than
  // a per-turn object, and building it per turn would be a second place for the
  // run wiring to live.
  const host: HeadlessRunHost = createHeadlessRunHost({ agent, toolRegistry: registry });

  // Track messages for persistence
  let pendingUserMessage: { id: string; content: string } | null = null;
  let pendingAssistantMessage: { id: string; content: string } | null = null;

  // Initialize slash commands
  initSlashCommands();

  const repl = new REPL({
    prompt: `${Colors.BRIGHT_GREEN}You${Colors.RESET} ${Colors.DIM}›${Colors.RESET} `,
    commands: getSlashCommands().map(cmd => `/${cmd.name}`),
    onLine: async (line) => {
      // Check for built-in commands
      const trimmed = line.trim();

      // Create context for slash commands with full session info
      const slashCommandContext = {
        agent,
        sessionId,
        platform: 'cli' as const,
      };

      // Handle slash commands
      if (trimmed === '/') {
        // Show slash command menu
        const selected = await showSlashCommandMenu();
        if (selected) {
          await executeSlashCommand(selected, slashCommandContext);
        }
        return;
      }

      if (isSlashCommand(trimmed)) {
        const handled = await executeSlashCommand(trimmed, slashCommandContext);
        if (handled) {
          // Handle special exit case - persist messages and stop REPL
          if (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q') {
            // Persist all messages before exit. Drop projection-synthesized
            // compaction checkpoint markers: the rebase event already carries
            // them inline, and a standalone copy collides with the
            // rebase-emitted id on the next load (duplicate message id).
            const allMessages = agent.getMessages();
            const persistableMessages = allMessages.filter(
              (m) => !(m.id ?? '').endsWith(COMPACTION_CHECKPOINT_ID_SUFFIX),
            );
            if (persistableMessages.length > 0) {
              await replaceMessages(sessionId, persistableMessages, 0);
            }
            // Update session title from first user message
            const firstUserMsg = allMessages.find((m) => m.role === 'user');
            if (firstUserMsg) {
              const title = typeof firstUserMsg.content === 'string'
                ? firstUserMsg.content.slice(0, 50)
                : 'Chat';
              updateSession(sessionId, { title });
            }
            repl.println(`${Colors.BRIGHT_YELLOW}Goodbye!${Colors.RESET}`);
            repl.println(`${Colors.DIM}Session saved: ${sessionId.slice(0, 8)}...${Colors.RESET}`);
            repl.stop();
          }
          return;
        }
      }

      // Handle /log command (not in slash command registry)
      if (trimmed === '/log' || trimmed.startsWith('/log ')) {
        const parts = trimmed.split(/\s+/);
        const filename = parts.length > 1 ? parts[1] : undefined;
        const logDir = sessionLogger.getLogDirectory?.() || process.cwd();
        repl.showLogs(logDir, filename);
        return;
      }

      // Log user input
      sessionLogger.logUser(trimmed);

      // Prepare user message for persistence
      pendingUserMessage = {
        id: crypto.randomUUID(),
        content: trimmed,
      };

      // Send to agent
      repl.printBlank();
      repl.printColored('Thinking... (Ctrl+C to cancel)', 'DIM');
      repl.printBlank();

      try {
        // Through the run layer (plan 587 H8.1). This used to be
        // `agent.streamChat(trimmed, ...)`, which made the CLI a second run
        // loop: it decided for itself when a turn ended and what the terminal
        // was. The host owns the run; the CLI renders its frames.
        const run = await host.start({
          prompt: trimmed,
          sessionId: sessionId ?? 'cli-interactive',
          cwd: workspace,
          model: model || '',
          providerId: 'cli',
        });
        await handleStreamEvents(agent, run.frames(), sessionLogger, sessionId, pendingUserMessage.id);
      } catch (error) {
        repl.printColored(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'RED');
        sessionLogger.logError(error instanceof Error ? error : String(error));
      }

      repl.printBlank();
    },
    onInterrupt: () => {
      agent.interrupt();
      repl.printBlank();
      repl.printColored('Interrupted.', 'YELLOW');
      repl.printBlank();
    },
  });

  // Keep the process alive
  return new Promise((resolve) => {
    repl.rl.on('close', () => {
      resolve();
    });
  });
}

/**
 * Run the agent with a single task (non-interactive mode)
 */
async function runTask(
  agent: duyaAgent,
  registry: ToolRegistry,
  task: string,
  sessionLogger: SessionLogger,
  runHost: HeadlessRunHost = createHeadlessRunHost({ agent, toolRegistry: registry })
): Promise<void> {
  console.log(`${Colors.BRIGHT_CYAN}Executing task...${Colors.RESET}\n`);

  // Log task
  sessionLogger.logUser(task);

  try {
    const run = await runHost.start({
      prompt: task,
      sessionId: 'cli-task',
      cwd: process.cwd(),
      model: '',
      providerId: 'cli',
    });
    await handleStreamEvents(agent, run.frames(), sessionLogger, '', '');
  } catch (error) {
    console.error(`${Colors.BRIGHT_RED}Error: ${error instanceof Error ? error.message : 'Unknown error'}${Colors.RESET}`);
    sessionLogger.logError(error instanceof Error ? error : String(error));
  }
}

/**
 * Report why provider resolution failed.
 *
 * Every branch names the ACTUAL problem — the missing file, the malformed
 * TOML, the provider id that is not defined, the exact secrets key that is
 * absent. That is the point of routing these through `file-config.ts`: the
 * old single "API key is required" message was printed for a user whose
 * provider was configured correctly and whose key was sitting in
 * secrets.json under a flat key the reader never looked for.
 *
 * When resolution succeeded but no key was usable, the user explicitly
 * passed `--api-key`/env overrides that were empty, so the generic advice
 * still applies.
 */
function reportProviderFailure(resolution: ProviderResolution): void {
  if (resolution.ok) {
    console.error(`${Colors.BRIGHT_RED}Error: API key is required${Colors.RESET}`);
    console.error(`Set it via --api-key option or the ANTHROPIC_API_KEY environment variable.`);
    return;
  }
  console.error(`${Colors.BRIGHT_RED}Error: ${resolution.message}${Colors.RESET}`);
  if (resolution.reason === 'api-key-missing') {
    console.error(`Pass --api-key to override the configured provider.`);
  }
}

/**
 * Main CLI entry point
 */
export async function runCLI(
  options: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    workspace?: string;
    task?: string;
    summaryLLMProvider?: 'anthropic' | 'openai';
    summaryLLMApiKey?: string;
    summaryLLMModel?: string;
    summaryLLMBaseUrl?: string;
  }
): Promise<void> {
  // Resolve provider configuration from ~/.duya/config.toml + secrets.json.
  // This used to read an `api_providers` row from the CLI's private duya.db,
  // a table the desktop deliberately dropped (migration
  // `drop_api_providers_table`), so it always came back empty and the run
  // died on the generic "API key is required".
  const resolution = resolveProvider(options.model);

  // Validate API key: CLI option > env var > config.toml provider > error
  let apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.API_KEY;
  if (!apiKey && resolution.ok) {
    apiKey = resolution.provider.apiKey;
  }
  if (!apiKey) {
    reportProviderFailure(resolution);
    process.exit(1);
  }

  // Determine model: CLI option > env var > provider default > fallback
  let model = options.model || process.env.ANTHROPIC_MODEL;
  if (!model && resolution.ok) {
    model = resolution.provider.model.model;
    if (resolution.provider.model.warning) {
      console.warn(`${Colors.YELLOW}Warning:${Colors.RESET} ${resolution.provider.model.warning}`);
    }
  }
  if (!model) {
    console.error(`${Colors.BRIGHT_RED}Error: Model is required${Colors.RESET}`);
    console.error(`Set it via --model option, ANTHROPIC_MODEL environment variable,`);
    console.error(`or run 'duya setup' to configure a provider with default model.`);
    process.exit(1);
  }

  // Determine baseURL: CLI option > env var > provider setting
  let baseURL = options.baseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!baseURL && resolution.ok) {
    baseURL = resolution.provider.baseUrl;
  }

  // Initialize agent options
  const agentOptions: AgentOptions = {
    apiKey,
    model,
    baseURL,
    workingDirectory: options.workspace || process.cwd(),
    communicationPlatform: 'cli',
  };

  // Create agent
  const agent = new duyaAgent(agentOptions);

  // Plan 610 A5: the CLI is a composition site, so it owns the sub-agent
  // dependencies outright. Both halves are already imported here.
  const subagentDeps: SubagentRunDeps = {
    createSubAgent: (subAgentOptions) => new duyaAgent(subAgentOptions),
    // Argument-less, matching what `runAgent` did before the cut.
    createToolRegistry: () => createBuiltinRegistry(subagentDeps),
  };

  // Get tool registry
  const registry = createBuiltinRegistry(subagentDeps);

  // Configure session search LLM if options provided
  if (options.summaryLLMProvider && options.summaryLLMApiKey) {
    const summaryLLMConfig: SummaryLLMConfig = {
      provider: options.summaryLLMProvider,
      apiKey: options.summaryLLMApiKey,
      model: options.summaryLLMModel || '',
      baseURL: options.summaryLLMBaseUrl,
    };
    sessionSearchTool.configureSummaryLLM(summaryLLMConfig);
    console.log(`${Colors.DIM}Session search LLM configured: ${options.summaryLLMProvider}/${summaryLLMConfig.model}${Colors.RESET}`);
  }

  // Load skills from filesystem
  const workspace = agentOptions.workingDirectory || process.cwd();

  // Load additional skill paths from settings
  const additionalPaths = getCliSettingJson<string[]>('skillAdditionalPaths', []);
  // Bundled skills are installed on-demand via the plugin marketplace (same
  // policy as the agent process); never auto-sync at CLI startup. System-level
  // (.system) skills are always loaded regardless of this flag.
  const loadOptions: { additionalPaths?: string[]; syncBundled: boolean } = {
    syncBundled: false,
    ...(additionalPaths.length > 0 ? { additionalPaths } : {}),
  };

  await loadSkills(workspace, loadOptions);
  const loadedSkills = getSkillRegistry().list();
  if (loadedSkills.length > 0) {
    console.log(`${Colors.DIM}Loaded ${loadedSkills.length} skill(s)${Colors.RESET}`);
  }

  // Initialize session logger with workspace
  const sessionLogger = initSessionLogger(undefined, workspace);
  sessionLogger.logSessionStart({
    model,
    workspace,
  });

  // Print banner in interactive mode.
  //
  // Skipped when the TUI will own the terminal: the banner would be painted
  // to the normal buffer a moment before the alternate screen takes over, so
  // the user would see it flash and vanish. The TUI reports the same facts as
  // transcript notices instead.
  if (!options.task && !shouldUseTui()) {
    printWelcomeBanner({
      model,
      workspace: agentOptions.workingDirectory || process.cwd(),
      toolCount: registry.size,
      skillCount: loadedSkills.length,
      mcpServers: [],
    });
  }

  try {
    // Run in appropriate mode
    if (options.task) {
      await runTask(agent, registry, options.task, sessionLogger);
    } else {
      await runInteractive(agent, registry, sessionLogger, model, workspace);
    }
  } finally {
    // Close session logger
    sessionLogger.logSessionEnd();
    closeSessionLogger();
  }
}

/**
 * Extract assistant text content from messages for print output.
 */
function extractPrintText(messages: readonly Message[]): string {
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') texts.push(block.text);
      }
    }
  }
  return texts.join('\n');
}

/**
 * Format messages as markdown for print output.
 */
function formatPrintMarkdown(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      lines.push(`## User\n\n${content}\n`);
    } else if (msg.role === 'assistant') {
      const content = msg.content;
      if (typeof content === 'string') {
        lines.push(`## Assistant\n\n${content}\n`);
      } else if (Array.isArray(content)) {
        lines.push('## Assistant\n');
        for (const block of content) {
          if (block.type === 'text') {
            lines.push(`\n${block.text}\n`);
          } else if (block.type === 'tool_use') {
            lines.push(`\n**[Tool: ${block.name}]**\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\`\n`);
          } else if (block.type === 'tool_result') {
            lines.push(`\n*[Tool Result]*\n${block.content}\n`);
          }
        }
      }
    }
  }
  return lines.join('---\n');
}

/**
 * Run a single headless print query against the agent and write formatted
 * output to stdout. Replaces the former QueryEngine.print path.
 */
async function runPrintQuery(
  agent: duyaAgent,
  prompt: string,
  format: string | undefined,
  runHost: HeadlessRunHost = createHeadlessRunHost({ agent })
): Promise<void> {
  let tokenUsage: { total_tokens?: number } = {};
  try {
    // Through the run layer (plan 587 H8.1). The usage number is now read off
    // the run's own `token_usage` frame rather than off the executor's private
    // `result` event, so `--format json` reports what the run recorded.
    const run = await runHost.start({
      prompt,
      sessionId: 'cli-print',
      cwd: process.cwd(),
      model: '',
      providerId: 'cli',
    });
    for await (const frame of run.frames()) {
      if (frame.type === 'token_usage') {
        const data = frame.data as { total_tokens?: number } | undefined;
        if (data?.total_tokens) tokenUsage = data;
      }
    }
  } catch (error) {
    console.error(`${Colors.BRIGHT_RED}Error:${Colors.RESET} ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const messages = agent.getMessages();
  const outputFormat = format || 'text';
  switch (outputFormat) {
    case 'json':
      console.log(JSON.stringify({
        content: extractPrintText(messages),
        toolCalls: messages
          .filter((m) => m.role === 'assistant')
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .filter((c) => c.type === 'tool_use'),
        tokenUsage,
      }, null, 2));
      break;
    case 'markdown':
      console.log(formatPrintMarkdown(messages));
      break;
    case 'text':
    default:
      console.log(extractPrintText(messages));
      break;
  }
}

/**
 * Run print mode - single query output
 */
async function runPrintMode(prompt: string, options: CLIOptions): Promise<void> {
  // Same resolution as the interactive path (config.toml + secrets.json).
  // This previously read the retired api_providers table, and additionally
  // seeded the model from ANTHROPIC_API_KEY -- the API key was being used as
  // the model name.
  const resolution = resolveProvider(options.model);

  let apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.API_KEY;
  if (!apiKey && resolution.ok) {
    apiKey = resolution.provider.apiKey;
  }
  if (!apiKey) {
    reportProviderFailure(resolution);
    process.exit(1);
  }

  let model = options.model || process.env.ANTHROPIC_MODEL;
  if (!model && resolution.ok) {
    model = resolution.provider.model.model;
    if (resolution.provider.model.warning) {
      console.warn(`${Colors.YELLOW}Warning:${Colors.RESET} ${resolution.provider.model.warning}`);
    }
  }

  let baseURL = options.baseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!baseURL && resolution.ok) {
    baseURL = resolution.provider.baseUrl;
  }

  const agent = new duyaAgent({
    apiKey,
    model: model || '',
    baseURL,
    workingDirectory: options.workspace,
    communicationPlatform: 'cli',
  });

  await runPrintQuery(agent, prompt, options.format);
}

/**
 * Run headless mode - execute from script file
 */
async function runHeadlessMode(scriptPath: string, options: CLIOptions): Promise<void> {
  // Same resolution as interactive and print mode (config.toml + secrets.json).
  const resolution = resolveProvider(options.model);

  let apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.API_KEY;
  if (!apiKey && resolution.ok) {
    apiKey = resolution.provider.apiKey;
  }
  if (!apiKey) {
    reportProviderFailure(resolution);
    process.exit(1);
  }

  let model = options.model || process.env.ANTHROPIC_MODEL;
  if (!model && resolution.ok) {
    model = resolution.provider.model.model;
    if (resolution.provider.model.warning) {
      console.warn(`${Colors.YELLOW}Warning:${Colors.RESET} ${resolution.provider.model.warning}`);
    }
  }

  let baseURL = options.baseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!baseURL && resolution.ok) {
    baseURL = resolution.provider.baseUrl;
  }

  // Read script file
  let scriptContent: string;
  try {
    const resolvedPath = resolve(process.cwd(), scriptPath);
    scriptContent = readFileSync(resolvedPath, 'utf-8');
  } catch (error) {
    console.error(`${Colors.BRIGHT_RED}Error: Could not read script file: ${scriptPath}${Colors.RESET}`);
    process.exit(1);
  }

  const agent = new duyaAgent({
    apiKey,
    model: model || '',
    baseURL,
    workingDirectory: options.workspace,
    communicationPlatform: 'cli',
  });

  // Execute each line as a separate prompt
  const lines = scriptContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue; // Skip empty lines and comments
    }

    console.log(`\n--- Executing: ${trimmed.slice(0, 50)}... ---\n`);
    await runPrintQuery(agent, trimmed, options.format);
  }
}

/**
 * CLI program setup
 *
 * The option table lives in `./cli-program.ts` so the interactive program and
 * the `--print` / `--headless` interception below are driven by the SAME
 * declarations (see that module for why this used to be a second parser).
 */
const program = createAgentProgram();

program.action(runCLI as never);

// Handle print and headless modes.
//
// `--print` / `--headless` are intercepted here, BEFORE commander reaches its
// own action handler, because in those modes the trailing positional is a
// prompt (or a script path) rather than an interactive REPL.
//
// The options are nevertheless parsed by COMMANDER, not by a second
// hand-rolled parser: `program.parseOptions()` runs the same option table
// that backs `--help` and the interactive path, so `-k`, `-u`, `-p` and `-w`
// are honoured here exactly as they are interactively. The previous
// `parseCLIArgs` recognised only `--model`, `--cwd`/`-c` and `--format`,
// silently dropping the other four, and assigned `--cwd` to BOTH `baseUrl`
// and `workspace`.
const args = process.argv.slice(2);
if (args.includes('--print') || args.includes('--headless') || args.includes('--script')) {
  const { operands, options: opts } = parseCliArgs(args);
  const scriptPath: string | undefined = opts.script;

  if (args.includes('--print')) {
    // The prompt is the first positional operand (`duya --print "hello"`),
    // not merely "the last token that is not a flag": the old check ran
    // indexOf() on the value, which misbehaved for a prompt that repeats.
    const prompt = operands[0];
    if (prompt === undefined) {
      console.error(`${Colors.BRIGHT_RED}Error: --print requires a prompt${Colors.RESET}`);
      process.exit(1);
    }
    runPrintMode(prompt, {
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      provider: opts.provider,
      workspace: opts.workspace,
      format: opts.format,
    }).catch((error) => {
      console.error(`${Colors.BRIGHT_RED}Fatal error:${Colors.RESET}`, error);
      process.exit(1);
    });
    process.exit(0);
  } else if (scriptPath !== undefined) {
    runHeadlessMode(scriptPath, {
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      provider: opts.provider,
      workspace: opts.workspace,
      format: opts.format,
    }).catch((error) => {
      console.error(`${Colors.BRIGHT_RED}Fatal error:${Colors.RESET}`, error);
      process.exit(1);
    });
    process.exit(0);
  }
}

// ============================================================================
// Agent runtime CLI: `duya` (REPL), `duya -t` (task), `duya --print`,
// `duya --headless --script ...`, `duya config show`, `duya setup`.
//
// The desktop control plane (status / plugin / session / skill / mcp /
// provider / channel / cron / message / install-cli) is in
// `@duya/cli` and bundled into the wrapper separately. Adding a
// new control-plane command is an edit to `packages/cli/src/...`,
// NOT to this file.
// ============================================================================

// `duya config show` (legacy, preserved as-is per roadmap §5.1)
program
  .command('config')
  .description(
    'Show current configuration (reads ~/.duya/config.toml + secrets.json, the store the desktop writes)',
  )
  .addCommand(
    new Command('show')
      .description('Show current configuration')
      .action(async () => {
        printHeader('Current Configuration')
        console.log(color('  API Key: ', Colors.DIM) + (process.env.ANTHROPIC_API_KEY ? color('***', Colors.GREEN) : color('not set', Colors.RED)))
        console.log(color('  Model: ', Colors.DIM) + (process.env.ANTHROPIC_MODEL || color('not set', Colors.RED)))
        console.log(color('  Base URL: ', Colors.DIM) + (process.env.ANTHROPIC_BASE_URL || color('not set (using default)', Colors.DIM)))
        console.log(color('  Workspace: ', Colors.DIM) + process.cwd())

        // Show the provider the CLI will actually use, and WHY it failed if
        // it cannot. This is the first place a user looks when the CLI
        // refuses to start, so it reports the same resolution the run path
        // performs rather than only the env vars.
        const resolution = resolveProvider(process.env.ANTHROPIC_MODEL);
        console.log()
        if (resolution.ok) {
          const p = resolution.provider;
          console.log(color('Resolved Provider:', Colors.CYAN))
          console.log(color('  Provider: ', Colors.DIM) + `${p.name} (${p.id})`)
          console.log(color('  Type: ', Colors.DIM) + `${p.providerType} -> ${p.protocol}`)
          console.log(color('  Model: ', Colors.DIM) + `${p.model.model} (from ${p.model.source})`)
          if (p.model.warning) console.log(color('  Warning: ', Colors.YELLOW) + p.model.warning)
        } else {
          console.log(color('Resolved Provider:', Colors.BRIGHT_RED) + ' none')
          console.log(color('  Reason: ', Colors.DIM) + resolution.reason)
          console.log(color('  Detail: ', Colors.DIM) + resolution.message)
        }

        // max_turns comes from config.toml ([agent].max_turns). It used to come
        // from the CLI's private duya.db, which the desktop never wrote, so
        // this always printed 'unlimited' regardless of the user's setting.
        const { getCliSetting } = await import('./config/db-config.js');
        const displayMode = getCliSetting('tool_display_mode') || 'verbose';
        const settings = readCliSettings();
        const maxTurns = settings.maxTurns !== undefined ? String(settings.maxTurns) : 'unlimited';
        const agentMode = getCliSetting('agent_mode') || 'code';

        console.log()
        console.log(color('Agent Settings:', Colors.CYAN))
        console.log(color('  Max turns: ', Colors.DIM) + maxTurns)
        console.log(color('  Agent mode: ', Colors.DIM) + agentMode)
        console.log(color('  Tool display: ', Colors.DIM) + displayMode)
      })
  )

// Setup command (legacy interactive wizard)
//
// LEGACY FOR A REASON: this wizard writes providers to its own private
// duya.db, a store the CLI no longer reads and the desktop dropped
// (`drop_api_providers_table`). Running it does NOT configure the CLI. Use
// the desktop Settings UI, or edit ~/.duya/config.toml + secrets.json.
program
  .command('setup [section]')
  .description(
    'Interactive setup wizard (legacy) — writes its own duya.db, which the CLI does not read. Use the desktop Settings UI instead.',
  )
  .option('--reset', 'Reset configuration to defaults')
  .action(async (section, options) => {
    const { runSetupWizard } = await import('./setup/index.js');

    if (options.reset) {
      const { resetConfig } = await import('./config/index.js');
      resetConfig();
      console.log(color('Configuration reset to defaults.', Colors.GREEN));
      return;
    }

    await runSetupWizard(section);
  })

// `duya image` — generate an image directly (plan image-gen). Reads
// [image_generation] from ~/.duya/config.toml; every option overrides it.
program
  .command('image <prompt>')
  .description('Generate an image via the configured provider ([image_generation] in config.toml)')
  .option('--provider <provider>', 'Provider: openai or fal (overrides config)')
  .option('--model <model>', 'Model id, e.g. gpt-image-1 or fal-ai/flux/dev (overrides config)')
  .option('--size <size>', 'Output size, e.g. 1024x1024 (overrides config)')
  .option('--quality <quality>', 'Quality: auto, low, medium, high (overrides config)')
  .option('--output <dir>', 'Output directory (overrides config)')
  .option('--output-name <name>', 'Output file base name (no extension)')
  .option('--json', 'Emit machine-readable JSON')
  .action(async (prompt, options) => {
    const { runImageCommand } = await import('./imageCmds.js');
    const code = await runImageCommand(prompt, options);
    if (code !== 0) process.exit(code);
  })

// `duya image:config` — print the effective image generation config.
program
  .command('image:config')
  .description('Show the effective [image_generation] configuration')
  .action(async () => {
    const { printImageConfigSummary } = await import('./imageCmds.js');
    printImageConfigSummary();
  })

program.parse();
