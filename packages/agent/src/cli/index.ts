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
import { duyaAgent, createBuiltinRegistry } from '../index.js';
import { sessionSearchTool, type SummaryLLMConfig } from '../tool/SessionSearchTool/index.js';
import type { AgentOptions, SSEEvent } from '../index.js';
import type { ToolRegistry } from '../index.js';
import { loadSkills, getSkillRegistry } from '../index.js';
import { QueryEngine } from '../query-engine/index.js';
import type { CLIParsedArgs } from '../query-engine/types.js';
import { Colors, color } from './colors.js';
import { REPL } from './repl.js';
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
import {
  initSlashCommands,
  executeSlashCommand,
  showSlashCommandMenu,
  isSlashCommand,
  getSlashCommands,
} from './slash-commands.js';

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
    skill_manage: 'name',
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
 * Handle SSE events from the agent and print formatted output
 */
async function handleStreamEvents(
  agent: duyaAgent,
  eventGen: AsyncGenerator<SSEEvent, void, unknown>,
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

  for await (const event of eventGen) {
    switch (event.type) {
      case 'text':
        currentText += event.data;
        break;

      case 'thinking':
        thinkingBuffer = event.data;
        break;

      case 'tool_use':
        if (currentText) {
          console.log(currentText);
          currentText = '';
        }
        stepToolCount++;

        if (isCompact) {
          // Compact mode: show tool name with preview only
          const preview = buildToolPreview(event.data.name, event.data.input);
          if (preview) {
            console.log(`${Colors.DIM}  → ${event.data.name}: ${preview}${Colors.RESET}`);
          } else {
            console.log(`${Colors.DIM}  → ${event.data.name}${Colors.RESET}`);
          }
        } else {
          // Verbose mode: show full tool call details
          console.log(`\n${Colors.BRIGHT_YELLOW}${Colors.TOOL} Tool Call:${Colors.RESET} ${Colors.BOLD}${Colors.CYAN}${event.data.name}${Colors.RESET}`);
          console.log(`${Colors.DIM}   Arguments:${Colors.RESET}`);
          try {
            const argsJson = JSON.stringify(event.data.input, null, 2);
            const lines = argsJson.split('\n');
            for (const line of lines) {
              console.log(`   ${Colors.DIM}${line}${Colors.RESET}`);
            }
          } catch {
            console.log(`   ${Colors.DIM}${JSON.stringify(event.data.input)}${Colors.RESET}`);
          }
        }
        // Log tool use
        sessionLogger.logTool(event.data.name, event.data.input);
        break;

      case 'tool_result':
        if (currentText) {
          console.log(currentText);
          currentText = '';
        }
        if (event.data.error) {
          if (isCompact) {
            console.log(`${Colors.DIM}    ${Colors.RED}✗ Error${Colors.RESET}`);
          } else {
            console.log(`${Colors.BRIGHT_RED}${Colors.ERROR} Error:${Colors.RESET} ${Colors.RED}${event.data.result}${Colors.RESET}`);
          }
        } else {
          if (isCompact) {
            // Compact mode: show success indicator with truncated result
            const result = event.data.result.length > 60
              ? event.data.result.slice(0, 57) + '...'
              : event.data.result;
            console.log(`${Colors.DIM}    ${Colors.GREEN}✓${Colors.RESET} ${Colors.DIM}${result}${Colors.RESET}`);
          } else {
            // Verbose mode: show full result
            const result = event.data.result.length > 300
              ? event.data.result.slice(0, 300) + `${Colors.DIM}...${Colors.RESET}`
              : event.data.result;
            console.log(`${Colors.BRIGHT_GREEN}${Colors.SUCCESS} Result:${Colors.RESET} ${result}`);
          }
        }
        break;

      case 'tool_progress':
        break;

      case 'tool_timeout':
        if (isCompact) {
          console.log(`${Colors.DIM}    ${Colors.YELLOW}⏱ timeout (${event.data.elapsedSeconds}s)${Colors.RESET}`);
        } else {
          console.log(`${Colors.BRIGHT_YELLOW}${Colors.TIMEOUT} Tool timed out: ${event.data.toolName} (${event.data.elapsedSeconds}s)${Colors.RESET}`);
        }
        break;

      case 'error':
        console.error(`${Colors.BRIGHT_RED}${Colors.ERROR} Error:${Colors.RESET} ${event.data}`);
        sessionLogger.logError(event.data);
        break;

      case 'result':
        if (event.data.total_tokens) {
          console.log(`${Colors.DIM}Token usage: ${event.data.total_tokens}${Colors.RESET}`);
        }
        break;

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
            // Persist all messages before exit
            const allMessages = agent.getMessages();
            if (allMessages.length > 0) {
              await replaceMessages(sessionId, allMessages, 0);
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
        const eventGen = agent.streamChat(trimmed, { toolRegistry: registry });
        await handleStreamEvents(agent, eventGen, sessionLogger, sessionId, pendingUserMessage.id);
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
  sessionLogger: SessionLogger
): Promise<void> {
  console.log(`${Colors.BRIGHT_CYAN}Executing task...${Colors.RESET}\n`);

  // Log task
  sessionLogger.logUser(task);

  try {
    const eventGen = agent.streamChat(task, { toolRegistry: registry });
    await handleStreamEvents(agent, eventGen, sessionLogger, '', '');
  } catch (error) {
    console.error(`${Colors.BRIGHT_RED}Error: ${error instanceof Error ? error.message : 'Unknown error'}${Colors.RESET}`);
    sessionLogger.logError(error instanceof Error ? error : String(error));
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
  // Initialize database to read provider configuration
  const { getActiveCliProvider } = await import('./config/db-config.js');
  const activeProvider = getActiveCliProvider();

  // Validate API key: CLI option > env var > database provider > error
  let apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.API_KEY;
  if (!apiKey && activeProvider?.api_key) {
    apiKey = activeProvider.api_key;
  }
  if (!apiKey) {
    console.error(`${Colors.BRIGHT_RED}Error: API key is required${Colors.RESET}`);
    console.error(`Set it via --api-key option, ANTHROPIC_API_KEY environment variable,`);
    console.error(`or run 'duya setup' to configure a provider.`);
    process.exit(1);
  }

  // Determine model: CLI option > env var > provider default > fallback
  let model = options.model || process.env.ANTHROPIC_MODEL;
  if (!model && activeProvider?.notes) {
    // Extract model from notes (format: "Default model: xxx")
    const match = activeProvider.notes.match(/Default model:\s*(.+)/);
    if (match) {
      model = match[1].trim();
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
  if (!baseURL && activeProvider?.base_url) {
    baseURL = activeProvider.base_url;
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

  // Get tool registry
  const registry = createBuiltinRegistry();

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
  const loadOptions = additionalPaths.length > 0 ? { additionalPaths } : undefined;

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

  // Print banner in interactive mode
  if (!options.task) {
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
 * Run print mode - single query output
 */
async function runPrintMode(prompt: string, options: CLIOptions): Promise<void> {
  // Load provider configuration from database
  const { getActiveCliProvider } = await import('./config/db-config.js');
  const activeProvider = getActiveCliProvider();

  // Get API key: CLI option > env var > database provider
  let apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.API_KEY;
  if (!apiKey && activeProvider?.api_key) {
    apiKey = activeProvider.api_key;
  }
  if (!apiKey) {
    console.error(`${Colors.BRIGHT_RED}Error: API key is required${Colors.RESET}`);
    console.error(`Set it via --api-key option, ANTHROPIC_API_KEY environment variable,`);
    console.error(`or run 'duya-agent setup' to configure a provider.`);
    process.exit(1);
  }

  // Get model and baseURL
  let model = options.model || process.env.ANTHROPIC_API_KEY;
  if (!model && activeProvider?.notes) {
    const match = activeProvider.notes.match(/Default model:\s*(.+)/);
    if (match) model = match[1].trim();
  }

  let baseURL = options.baseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!baseURL && activeProvider?.base_url) {
    baseURL = activeProvider.base_url;
  }

  const engine = new QueryEngine({
    agentConfig: {
      apiKey,
      model: model || '',
      baseURL,
      workingDirectory: options.workspace,
      communicationPlatform: 'cli',
    },
    mode: 'print',
    workingDirectory: options.workspace,
  });

  await engine.print(prompt, {
    format: options.format,
    cwd: options.workspace,
  });
}

/**
 * Run headless mode - execute from script file
 */
async function runHeadlessMode(scriptPath: string, options: CLIOptions): Promise<void> {
  // Load provider configuration from database
  const { getActiveCliProvider } = await import('./config/db-config.js');
  const activeProvider = getActiveCliProvider();

  // Get API key: CLI option > env var > database provider
  let apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.API_KEY;
  if (!apiKey && activeProvider?.api_key) {
    apiKey = activeProvider.api_key;
  }
  if (!apiKey) {
    console.error(`${Colors.BRIGHT_RED}Error: API key is required${Colors.RESET}`);
    console.error(`Set it via --api-key option, ANTHROPIC_API_KEY environment variable,`);
    console.error(`or run 'duya-agent setup' to configure a provider.`);
    process.exit(1);
  }

  // Get model and baseURL
  let model = options.model || process.env.ANTHROPIC_MODEL;
  if (!model && activeProvider?.notes) {
    const match = activeProvider.notes.match(/Default model:\s*(.+)/);
    if (match) model = match[1].trim();
  }

  let baseURL = options.baseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!baseURL && activeProvider?.base_url) {
    baseURL = activeProvider.base_url;
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

  const engine = new QueryEngine({
    agentConfig: {
      apiKey,
      model: model || '',
      baseURL,
      workingDirectory: options.workspace,
      communicationPlatform: 'cli',
    },
    mode: 'print',
    workingDirectory: options.workspace,
  });

  // Execute each line as a separate prompt
  const lines = scriptContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue; // Skip empty lines and comments
    }

    console.log(`\n--- Executing: ${trimmed.slice(0, 50)}... ---\n`);
    await engine.print(trimmed, {
      format: options.format,
      cwd: options.workspace,
    });
  }
}

/**
 * CLI program setup
 */
const program = new Command();

program
  .name('duya')
  .description('DUYA Agent - AI Agent with tools and MCP support')
  .version('0.2.0')
  .option('-k, --api-key <key>', 'API key for LLM provider')
  .option('-m, --model <model>', 'Model to use')
  .option('-u, --base-url <url>', 'Base URL for API')
  .option('-p, --provider <provider>', 'LLM provider protocol: anthropic or openai')
  .option('-w, --workspace <dir>', 'Workspace directory', process.cwd())
  .option('-t, --task <task>', 'Execute task and exit (non-interactive mode)')
  .option('--print', 'Print mode: single query and exit')
  .option('--headless', 'Headless mode: read from script file')
  .option('--script <path>', 'Script file path for headless mode')
  .option('-f, --format <format>', 'Output format: text, json, markdown')
  .option('--continue [sessionId]', 'Continue a previous session (optional session ID)')
  .option('--resume [sessionId]', 'Resume a session (alias for --continue)')
  .option('--summary-provider <provider>', 'Provider for session search summarization: anthropic or openai')
  .option('--summary-api-key <key>', 'API key for session search summarization LLM')
  .option('--summary-model <model>', 'Model for session search summarization')
  .option('--summary-base-url <url>', 'Base URL for session search summarization LLM')
  .action(runCLI);

// Handle print and headless modes before normal parsing
const args = process.argv.slice(2);
if (args.includes('--print') || args.includes('--headless') || args.includes('--script')) {
  const parsed = parseCLIArgs(args);
  if (parsed.mode === 'print' && parsed.prompt) {
    runPrintMode(parsed.prompt, {
      model: parsed.options.model,
      baseUrl: parsed.options.cwd,
      workspace: parsed.options.cwd,
      format: parsed.options.format,
    }).catch((error) => {
      console.error(`${Colors.BRIGHT_RED}Fatal error:${Colors.RESET}`, error);
      process.exit(1);
    });
    process.exit(0);
  } else if (parsed.mode === 'headless' && parsed.scriptPath) {
    runHeadlessMode(parsed.scriptPath, {
      model: parsed.options.model,
      baseUrl: parsed.options.cwd,
      workspace: parsed.options.cwd,
      format: parsed.options.format,
    }).catch((error) => {
      console.error(`${Colors.BRIGHT_RED}Fatal error:${Colors.RESET}`, error);
      process.exit(1);
    });
    process.exit(0);
  }
}

// CLI argument parser for custom modes
function parseCLIArgs(args: string[]): CLIParsedArgs {
  const mode: 'interactive' | 'print' | 'headless' = args.includes('--headless') ? 'headless' :
    args.includes('--print') ? 'print' : 'interactive';

  const scriptPath = args.includes('--script') ? args[args.indexOf('--script') + 1] : undefined;
  const prompt = args[args.length - 1] && !args[args.indexOf(args[args.length - 1])]?.startsWith('--') ?
    args[args.length - 1] : undefined;

  const getOption = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  return {
    mode,
    prompt,
    scriptPath,
    options: {
      model: getOption('--model') || getOption('-m'),
      cwd: getOption('--cwd') || getOption('-c'),
      format: getOption('--format') as 'text' | 'json' | 'markdown' | undefined,
    },
  };
}

// ============================================================================
// Subcommands
// ============================================================================

// Session subcommands
program
  .command('session')
  .description('Session management')
  .addCommand(
    new Command('list')
      .description('List recent sessions')
      .action(async () => {
        // Placeholder - will integrate with actual session DB
        printHeader('Recent Sessions')
        console.log(color('  (Session storage not yet implemented)', Colors.DIM))
      })
  )
  .addCommand(
    new Command('continue')
      .option('-i, --id <sessionId>', 'Session ID to continue')
      .description('Continue a previous session')
      .action(async (options) => {
        printHeader('Continue Session')
        console.log(color('  (Session storage not yet implemented)', Colors.DIM))
      })
  )
  .addCommand(
    new Command('delete')
      .description('Delete a session')
      .action(async () => {
        printHeader('Delete Session')
        console.log(color('  (Session storage not yet implemented)', Colors.DIM))
      })
  )

// Provider subcommands
program
  .command('provider')
  .description('Provider configuration')
  .addCommand(
    new Command('list')
      .description('List configured providers')
      .action(async () => {
        // Placeholder - will integrate with actual provider config
        printHeader('Configured Providers')
        console.log(color('  (Provider storage not yet implemented)', Colors.DIM))
      })
  )
  .addCommand(
    new Command('add')
      .description('Add a new provider interactively')
      .action(async () => {
        const config = await addProviderInteractive()
        if (config) {
          printSuccess('Provider configuration created')
          printInfo('(Provider storage not yet implemented)')
        }
      })
  )

// Config subcommands
program
  .command('config')
  .description('Configuration management')
  .addCommand(
    new Command('show')
      .description('Show current configuration')
      .action(async () => {
        printHeader('Current Configuration')
        console.log(color('  API Key: ', Colors.DIM) + (process.env.ANTHROPIC_API_KEY ? color('***', Colors.GREEN) : color('not set', Colors.RED)))
        console.log(color('  Model: ', Colors.DIM) + (process.env.ANTHROPIC_MODEL || color('not set', Colors.RED)))
        console.log(color('  Base URL: ', Colors.DIM) + (process.env.ANTHROPIC_BASE_URL || color('not set (using default)', Colors.DIM)))
        console.log(color('  Workspace: ', Colors.DIM) + process.cwd())
        
        // Load settings from database
        const { getCliSetting } = await import('./config/db-config.js');
        const displayMode = getCliSetting('tool_display_mode') || 'verbose';
        const maxTurns = getCliSetting('max_turns') || '90';
        const agentMode = getCliSetting('agent_mode') || 'code';
        
        console.log()
        console.log(color('Agent Settings:', Colors.CYAN))
        console.log(color('  Max turns: ', Colors.DIM) + maxTurns)
        console.log(color('  Agent mode: ', Colors.DIM) + agentMode)
        console.log(color('  Tool display: ', Colors.DIM) + displayMode)
      })
  )

// MCP subcommands
program
  .command('mcp')
  .description('MCP server management')
  .addCommand(
    new Command('list')
      .description('List MCP servers')
      .action(async () => {
        printHeader('MCP Servers')
        console.log(color('  (MCP storage not yet implemented)', Colors.DIM))
      })
  )
  .addCommand(
    new Command('check')
      .description('Check MCP server status')
      .action(async () => {
        printHeader('MCP Check')
        console.log(color('  Usage: duya mcp check <name>', Colors.DIM))
      })
  )

// Setup command - interactive configuration wizard
program
  .command('setup [section]')
  .description('Interactive setup wizard for configuration')
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

program.parse();
