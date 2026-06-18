/**
 * electron/services/terminal/TerminalManager.ts
 *
 * Owns long-lived PTY sessions for the right sidebar terminal. React panels
 * attach/detach from these sessions; closing a panel tab is the point where the
 * process is killed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { createRequire } from 'module';
import type * as NodePty from 'node-pty';
import { getDatabase } from '../../db/connection';
import { getLogger, LogComponent } from '../../logging/logger';

const logger = getLogger();

export type TerminalShell = 'powershell' | 'pwsh' | 'bash' | 'zsh' | 'fish' | 'sh' | 'cmd';
export type TerminalStatus = 'running' | 'exited';

export interface TerminalSpawnOptions {
  id: string;
  shell?: TerminalShell;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface TerminalHandle {
  id: string;
  pid: number;
  shell: TerminalShell;
  cwd: string;
  title: string;
  status: TerminalStatus;
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
}

export interface TerminalOutputEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  code: number | null;
}

export interface TerminalSnapshot {
  handle: TerminalHandle;
  scrollback: string;
}

export interface TerminalSuggestion {
  command: string;
  suffix: string;
  useCount: number;
  lastUsedAt: number;
}

export type TerminalEvent =
  | { type: 'output'; payload: TerminalOutputEvent }
  | { type: 'exit'; payload: TerminalExitEvent };

export type TerminalEventListener = (event: TerminalEvent) => void;

interface ActiveTerminal {
  handle: TerminalHandle;
  proc: NodePty.IPty;
  scrollback: string[];
  inputLine: string;
}

const MAX_SCROLLBACK_CHARS = 200_000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
let nodePtyModule: typeof NodePty | null = null;

function loadNodePty(): typeof NodePty {
  if (nodePtyModule) return nodePtyModule;
  if (app.isPackaged) {
    const packageJson = path.join(process.resourcesPath, 'node-pty', 'package.json');
    if (fs.existsSync(packageJson)) {
      nodePtyModule = createRequire(packageJson)('./') as typeof NodePty;
    } else {
      // Fall back to node_modules if packaged path doesn't exist (e.g., Playwright e2e)
      nodePtyModule = require('node-pty') as typeof NodePty;
    }
  } else {
    nodePtyModule = require('node-pty') as typeof NodePty;
  }
  return nodePtyModule;
}

function commandExists(command: string): boolean {
  if (process.platform === 'win32') return true;
  const pathEnv = process.env.PATH ?? '';
  return pathEnv.split(path.delimiter).some((dir) => {
    try {
      return fs.existsSync(path.join(dir, command));
    } catch {
      return false;
    }
  });
}

function shellFromBasename(file: string): TerminalShell | null {
  const base = path.basename(file).toLowerCase();
  if (base === 'pwsh' || base === 'pwsh.exe') return 'pwsh';
  if (base === 'powershell' || base === 'powershell.exe') return 'powershell';
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (base === 'zsh') return 'zsh';
  if (base === 'fish') return 'fish';
  if (base === 'bash') return 'bash';
  if (base === 'sh') return 'sh';
  return null;
}

function defaultShell(): TerminalShell {
  if (process.platform === 'win32') {
    if (process.env.ComSpec?.toLowerCase().endsWith('cmd.exe')) return 'pwsh';
    return 'pwsh';
  }
  const fromEnv = process.env.SHELL ? shellFromBasename(process.env.SHELL) : null;
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin' && commandExists('zsh')) return 'zsh';
  if (commandExists('bash')) return 'bash';
  return 'sh';
}

function defaultCwd(): string {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || process.cwd();
}

function resolveShellCommand(shell: TerminalShell): { file: string; args: string[] } {
  switch (shell) {
    case 'powershell':
      return { file: 'powershell.exe', args: ['-NoLogo'] };
    case 'pwsh':
      return { file: 'pwsh', args: ['-NoLogo'] };
    case 'cmd':
      return { file: 'cmd.exe', args: [] };
    case 'zsh':
      return { file: process.platform === 'win32' ? 'zsh' : '/bin/zsh', args: ['-i'] };
    case 'fish':
      return { file: 'fish', args: ['-i'] };
    case 'bash':
      return { file: process.platform === 'win32' ? 'bash' : '/bin/bash', args: ['-i'] };
    case 'sh':
      return { file: process.platform === 'win32' ? 'sh' : '/bin/sh', args: ['-i'] };
  }
}

function sanitizeCwd(cwd: string): string {
  try {
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  } catch {
    // Fall through.
  }
  return defaultCwd();
}

function normalizeCommand(input: string): string {
  return input.trim();
}

function applyInputToLine(current: string, data: string): { line: string; submitted?: string } {
  let line = current;
  let submitted: string | undefined;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      submitted = line;
      line = '';
    } else if (ch === '\u007f' || ch === '\b') {
      line = line.slice(0, -1);
    } else if (ch === '\u0003' || ch === '\u0015') {
      line = '';
    } else if (ch === '\t' || ch === '\u001b') {
      // Shell owns completion and escape sequences.
    } else if (ch >= ' ') {
      line += ch;
    }
  }
  return { line, submitted };
}

export class TerminalManager {
  private readonly terminals = new Map<string, ActiveTerminal>();
  private readonly listeners = new Set<TerminalEventListener>();
  private readonly log = logger;

  subscribe(listener: TerminalEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): TerminalHandle[] {
    return Array.from(this.terminals.values()).map((t) => ({ ...t.handle }));
  }

  getSnapshot(id: string): TerminalSnapshot | null {
    const entry = this.terminals.get(id);
    if (!entry) return null;
    return {
      handle: { ...entry.handle },
      scrollback: entry.scrollback.join(''),
    };
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  spawn(options: TerminalSpawnOptions): TerminalSnapshot {
    const existing = this.getSnapshot(options.id);
    if (existing) return existing;

    const requestedShell = options.shell ?? defaultShell();
    const cwd = sanitizeCwd(options.cwd ?? defaultCwd());
    const { file, args } = resolveShellCommand(requestedShell);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: process.platform === 'win32' ? 'xterm-256color' : (process.env.TERM || 'xterm-256color'),
      COLORTERM: process.env.COLORTERM || 'truecolor',
      DUYA_TERMINAL_ID: options.id,
      ...(options.env ?? {}),
    };

    let proc: NodePty.IPty;
    try {
      const pty = loadNodePty();
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: options.cols ?? DEFAULT_COLS,
        rows: options.rows ?? DEFAULT_ROWS,
        cwd,
        env,
        windowsHide: true,
      });
    } catch (err) {
      if (requestedShell === 'pwsh') {
        return this.spawn({ ...options, shell: 'powershell' });
      }
      if (requestedShell === 'powershell') {
        return this.spawn({ ...options, shell: 'cmd' });
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Terminal PTY spawn failed', {
        id: options.id,
        shell: requestedShell,
        error: message,
      }, LogComponent.Main);
      throw err;
    }

    const now = Date.now();
    const handle: TerminalHandle = {
      id: options.id,
      pid: proc.pid,
      shell: requestedShell,
      cwd,
      title: options.title || `Terminal ${this.terminals.size + 1}`,
      status: 'running',
      createdAt: now,
    };

    const entry: ActiveTerminal = {
      handle,
      proc,
      scrollback: [],
      inputLine: '',
    };
    this.terminals.set(options.id, entry);

    proc.onData((data) => {
      this.appendScrollback(entry, data);
      this.emit({ type: 'output', payload: { id: options.id, data } });
    });

    proc.onExit(({ exitCode }) => {
      entry.handle.status = 'exited';
      entry.handle.exitedAt = Date.now();
      entry.handle.exitCode = exitCode;
      this.emit({ type: 'exit', payload: { id: options.id, code: exitCode } });
    });

    this.log.info('Terminal PTY spawned', {
      id: options.id,
      pid: proc.pid,
      shell: requestedShell,
      cwd,
    }, LogComponent.Main);

    return { handle: { ...handle }, scrollback: '' };
  }

  write(id: string, data: string): boolean {
    const entry = this.terminals.get(id);
    if (!entry || entry.handle.status !== 'running') return false;

    const next = applyInputToLine(entry.inputLine, data);
    entry.inputLine = next.line;
    if (next.submitted !== undefined) {
      this.recordCommand(next.submitted, entry.handle.shell, entry.handle.cwd, 'user');
    }

    try {
      entry.proc.write(data);
      return true;
    } catch (err) {
      this.log.warn('Terminal write failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.Main);
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const entry = this.terminals.get(id);
    if (!entry || entry.handle.status !== 'running') return false;
    try {
      entry.proc.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
      return true;
    } catch (err) {
      this.log.warn('Terminal resize failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.Main);
      return false;
    }
  }

  kill(id: string): boolean {
    const entry = this.terminals.get(id);
    if (!entry) return false;
    try {
      entry.proc.kill();
      this.terminals.delete(id);
      return true;
    } catch (err) {
      this.log.warn('Terminal kill failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.Main);
      return false;
    }
  }

  killAll(): void {
    for (const id of Array.from(this.terminals.keys())) {
      this.kill(id);
    }
  }

  suggest(prefix: string, shell?: TerminalShell, cwd?: string, limit = 8): TerminalSuggestion[] {
    const db = getDatabase();
    const trimmed = prefix.trimStart();
    if (!db || trimmed.length === 0) return [];

    const params: unknown[] = [`${trimmed}%`];
    const where: string[] = ['command LIKE ?'];
    if (shell) {
      where.push('shell = ?');
      params.push(shell);
    }
    if (cwd) {
      where.push('cwd = ?');
      params.push(cwd);
    }
    params.push(Math.max(1, Math.min(20, limit)));

    try {
      const rows = db.prepare(`
        SELECT command, use_count AS useCount, last_used_at AS lastUsedAt
        FROM terminal_command_history
        WHERE ${where.join(' AND ')}
        ORDER BY use_count DESC, last_used_at DESC
        LIMIT ?
      `).all(...params) as Array<{ command: string; useCount: number; lastUsedAt: number }>;
      return rows
        .filter((row) => row.command !== trimmed && row.command.startsWith(trimmed))
        .map((row) => ({
          command: row.command,
          suffix: row.command.slice(trimmed.length),
          useCount: row.useCount,
          lastUsedAt: row.lastUsedAt,
        }));
    } catch (err) {
      this.log.warn('Terminal suggestion query failed', {
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.Main);
      return [];
    }
  }

  recordCommand(commandInput: string, shell: TerminalShell, cwd: string, source = 'user'): void {
    const command = normalizeCommand(commandInput);
    if (!command) return;
    const db = getDatabase();
    if (!db) return;
    const now = Date.now();
    try {
      db.prepare(`
        INSERT INTO terminal_command_history
          (id, command, shell, cwd, source, use_count, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(command, shell, cwd, source)
        DO UPDATE SET
          use_count = use_count + 1,
          last_used_at = excluded.last_used_at
      `).run(randomUUID(), command, shell, cwd, source, now, now);
    } catch (err) {
      this.log.warn('Terminal command history write failed', {
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.Main);
    }
  }

  private appendScrollback(entry: ActiveTerminal, data: string): void {
    entry.scrollback.push(data);
    let total = entry.scrollback.reduce((sum, chunk) => sum + chunk.length, 0);
    while (total > MAX_SCROLLBACK_CHARS && entry.scrollback.length > 1) {
      const removed = entry.scrollback.shift() ?? '';
      total -= removed.length;
    }
  }

  private emit(event: TerminalEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn('Terminal listener threw', {
          error: err instanceof Error ? err.message : String(err),
        }, LogComponent.Main);
      }
    }
  }
}

let instance: TerminalManager | null = null;

export function getTerminalManager(): TerminalManager {
  if (!instance) {
    instance = new TerminalManager();
  }
  return instance;
}

export function newTerminalId(): string {
  return `term-${randomUUID()}`;
}
