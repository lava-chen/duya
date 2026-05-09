/**
 * Interactive REPL for duya Agent CLI
 * Enhanced with persistent history and improved commands
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { Colors } from './colors.js';

export interface REPLOptions {
  prompt?: string;
  onLine: (line: string) => void | Promise<void>;
  onInterrupt?: () => void;
  commands?: string[];
  historyFile?: string;
}

export class REPL {
  private _rl: readline.Interface;
  private options: REPLOptions;
  private isRunning: boolean = false;
  private currentHandler: ((line: string) => void | Promise<void>) | null = null;
  private history: string[] = [];
  private historyFile: string;

  /**
   * Get the readline interface for external event handling
   */
  get rl(): readline.Interface {
    return this._rl;
  }

  constructor(options: REPLOptions) {
    this.options = {
      prompt: '> ',
      commands: ['/help', '/clear', '/history', '/exit', '/log'],
      ...options,
    };

    // Setup history file path
    this.historyFile = options.historyFile || path.join(homedir(), '.duya', '.cli_history');
    this.loadHistory();

    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      completer: (line: string) => {
        const hits = this.options.commands?.filter((c) => c.startsWith(line)) || [];
        return [hits.length > 0 ? hits : [], line];
      },
      history: [...this.history],
      historySize: 1000,
    });

    // Handle line input
    this._rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        // Add to history
        this.addToHistory(trimmed);
        this.currentHandler = this.options.onLine;
        try {
          await this.options.onLine(trimmed);
        } finally {
          this.currentHandler = null;
        }
      }
      // Show prompt again after processing
      if (this.isRunning) {
        this.prompt();
      }
    });

    // Handle Ctrl+C
    this._rl.on('SIGINT', () => {
      if (this.currentHandler) {
        // If we're in the middle of processing, interrupt the handler
        this.currentHandler = null;
        this.options.onInterrupt?.();
      } else {
        // Idle - exit the REPL
        process.stdout.write('\r\n');
        this.stop();
      }
    });

    // Save history on exit
    this._rl.on('close', () => {
      this.saveHistory();
    });
  }

  /**
   * Load history from file
   */
  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyFile)) {
        const content = fs.readFileSync(this.historyFile, 'utf-8');
        this.history = content.split('\n').filter(line => line.trim());
      }
    } catch {
      // Ignore errors
      this.history = [];
    }
  }

  /**
   * Save history to file
   */
  private saveHistory(): void {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Keep last 1000 entries
      const recentHistory = this.history.slice(-1000);
      fs.writeFileSync(this.historyFile, recentHistory.join('\n'), 'utf-8');
    } catch {
      // Ignore errors
    }
  }

  /**
   * Add entry to history
   */
  private addToHistory(line: string): void {
    // Don't add duplicate consecutive entries
    if (this.history.length === 0 || this.history[this.history.length - 1] !== line) {
      this.history.push(line);
    }
  }

  /**
   * Start the REPL
   */
  start(): void {
    this.isRunning = true;
    // Set the prompt text
    this._rl.setPrompt(this.options.prompt || '> ');
    // Show prompt
    this._rl.prompt();
  }

  /**
   * Stop the REPL
   */
  stop(): void {
    this.isRunning = false;
    this.saveHistory();
    this._rl.close();
  }

  /**
   * Check if REPL is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Show the prompt and wait for input
   */
  private prompt(): void {
    if (!this.isRunning) return;
    this._rl.prompt();
  }

  /**
   * Print a message to stdout (without adding a new line)
   */
  print(message: string): void {
    process.stdout.write(message);
  }

  /**
   * Print a line to stdout
   */
  println(message: string): void {
    console.log(message);
  }

  /**
   * Print a colored line
   */
  printColored(message: string, color: keyof typeof Colors): void {
    console.log(`${Colors[color]}${message}${Colors.RESET}`);
  }

  /**
   * Print a blank line
   */
  printBlank(): void {
    process.stdout.write('\n');
  }

  /**
   * Print help information
   */
  printHelp(): void {
    console.log(`
${Colors.BOLD}${Colors.BRIGHT_CYAN}duya Agent CLI - Help${Colors.RESET}

${Colors.BOLD}Commands:${Colors.RESET}
  ${Colors.BRIGHT_GREEN}/help${Colors.RESET}     - Show this help message
  ${Colors.BRIGHT_GREEN}/clear${Colors.RESET}    - Clear session history
  ${Colors.BRIGHT_GREEN}/history${Colors.RESET}  - Show message statistics
  ${Colors.BRIGHT_GREEN}/log${Colors.RESET}      - Show recent log files
  ${Colors.BRIGHT_GREEN}/log <file>${Colors.RESET} - Read a specific log file
  ${Colors.BRIGHT_GREEN}/exit${Colors.RESET}     - Exit the program

${Colors.BOLD}Keyboard Shortcuts:${Colors.RESET}
  ${Colors.BRIGHT_CYAN}Ctrl+C${Colors.RESET}    - Interrupt execution or exit
  ${Colors.BRIGHT_CYAN}↑/↓${Colors.RESET}       - Browse command history
  ${Colors.BRIGHT_CYAN}Tab${Colors.RESET}       - Auto-complete commands

${Colors.BOLD}Usage:${Colors.RESET}
  - Enter your task directly, Agent will help you complete it
  - Agent remembers all conversation content in this session
  - Use ${Colors.BRIGHT_GREEN}/clear${Colors.RESET} to start a new session
`);
  }

  /**
   * Show log directory and recent files
   */
  showLogs(logDir: string, filename?: string): void {
    if (filename) {
      this.readLogFile(logDir, filename);
      return;
    }

    const { format } = require('date-format');

    console.log(`\n${Colors.BRIGHT_CYAN}📁 Log Directory: ${logDir}${Colors.RESET}`);

    if (!fs.existsSync(logDir)) {
      console.log(`${Colors.YELLOW}Log directory does not exist.${Colors.RESET}\n`);
      return;
    }

    const logFiles = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const stat = fs.statSync(path.join(logDir, f));
        return { name: f, mtime: stat.mtime, size: stat.size };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (logFiles.length === 0) {
      console.log(`${Colors.YELLOW}No log files found.${Colors.RESET}\n`);
      return;
    }

    console.log(`${Colors.DIM}${'─'.repeat(60)}${Colors.RESET}`);
    console.log(`${Colors.BOLD}${Colors.BRIGHT_YELLOW}Recent Log Files:${Colors.RESET}`);

    for (let i = 0; i < Math.min(10, logFiles.length); i++) {
      const file = logFiles[i];
      const mtimeStr = file.mtime.toISOString().slice(0, 19).replace('T', ' ');
      const sizeStr = file.size < 1024 ? `${file.size}B` : `${(file.size / 1024).toFixed(1)}K`;
      const num = String(i + 1).padStart(2, ' ');
      console.log(`  ${Colors.GREEN}${num}.${Colors.RESET} ${Colors.BRIGHT_WHITE}${file.name}${Colors.RESET}`);
      console.log(`      ${Colors.DIM}Modified: ${mtimeStr}, Size: ${sizeStr}${Colors.RESET}`);
    }

    if (logFiles.length > 10) {
      const remaining = logFiles.length - 10;
      console.log(`  ${Colors.DIM}... and ${remaining} more files${Colors.RESET}`);
    }

    console.log(`${Colors.DIM}${'─'.repeat(60)}${Colors.RESET}`);
    console.log(`${Colors.DIM}Use /log <filename> to read a specific log file${Colors.RESET}\n`);
  }

  /**
   * Read and display a log file
   */
  private readLogFile(logDir: string, filename: string): void {
    const logFile = path.join(logDir, filename);

    if (!fs.existsSync(logFile)) {
      console.log(`\n${Colors.RED}Log file not found: ${filename}${Colors.RESET}\n`);
      return;
    }

    console.log(`\n${Colors.BRIGHT_CYAN}Reading: ${filename}${Colors.RESET}`);
    console.log(`${Colors.DIM}${'─'.repeat(80)}${Colors.RESET}`);

    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      console.log(content);
      console.log(`${Colors.DIM}${'─'.repeat(80)}${Colors.RESET}`);
      console.log(`\n${Colors.GREEN}End of file${Colors.RESET}\n`);
    } catch (e) {
      console.log(`\n${Colors.RED}Error reading file: ${e}${Colors.RESET}\n`);
    }
  }
}

/**
 * Create and start a REPL instance
 */
export function createREPL(options: REPLOptions): REPL {
  const repl = new REPL(options);
  repl.start();
  return repl;
}
