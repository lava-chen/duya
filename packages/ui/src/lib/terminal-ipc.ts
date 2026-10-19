/**
 * Typed wrapper around the preload-bridged terminal IPC surface.
 */

export type TerminalShell = 'powershell' | 'pwsh' | 'bash' | 'zsh' | 'fish' | 'sh' | 'cmd';
export type TerminalStatus = 'running' | 'exited';

export interface TerminalSpawnParams {
  id?: string;
  shell?: TerminalShell;
  cwd?: string;
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

export interface TerminalSnapshot {
  handle: TerminalHandle;
  scrollback: string;
}

export interface TerminalSpawnResult {
  ok: boolean;
  handle?: TerminalHandle;
  scrollback?: string;
  error?: string;
}

export interface TerminalOutputEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  code: number | null;
}

export interface TerminalSuggestion {
  command: string;
  suffix: string;
  useCount: number;
  lastUsedAt: number;
}

function api() {
  if (typeof window === 'undefined' || !window.electronAPI) {
    throw new Error('terminal-ipc: window.electronAPI is not available');
  }
  return window.electronAPI;
}

export async function spawnTerminal(
  params: TerminalSpawnParams = {},
): Promise<TerminalSpawnResult> {
  return api().terminal.spawn(params) as Promise<TerminalSpawnResult>;
}

export async function listTerminals(): Promise<TerminalHandle[]> {
  const res = await api().terminal.list();
  return res.ok ? (res.terminals as TerminalHandle[]) : [];
}

export async function getTerminalSnapshot(id: string): Promise<TerminalSnapshot | null> {
  const res = await api().terminal.snapshot(id);
  return res.ok && res.snapshot ? (res.snapshot as TerminalSnapshot) : null;
}

export async function writeToTerminal(id: string, data: string): Promise<boolean> {
  const res = await api().terminal.write(id, data);
  return res.ok;
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<boolean> {
  const res = await api().terminal.resize(id, cols, rows);
  return res.ok;
}

export async function killTerminal(id: string): Promise<boolean> {
  const res = await api().terminal.kill(id);
  return res.ok;
}

export async function suggestTerminalCommand(
  prefix: string,
  shell?: string,
  cwd?: string,
  limit = 8,
): Promise<TerminalSuggestion[]> {
  const res = await api().terminal.suggest(prefix, shell, cwd, limit);
  return res.ok ? (res.suggestions as TerminalSuggestion[]) : [];
}

export async function recordTerminalCommand(
  command: string,
  shell: string,
  cwd: string,
  source = 'user',
): Promise<boolean> {
  const res = await api().terminal.record(command, shell, cwd, source);
  return res.ok;
}

export function onTerminalOutput(callback: (event: TerminalOutputEvent) => void): () => void {
  return api().onTerminalOutput(callback);
}

export function onTerminalExit(callback: (event: TerminalExitEvent) => void): () => void {
  return api().onTerminalExit(callback);
}
