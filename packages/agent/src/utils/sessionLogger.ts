/**
 * Session logger for CLI
 * Records CLI sessions to ~/.duya/cli_sessions/{workspace}/{timestamp}.log
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export interface SessionLogEntry {
  timestamp: string;
  type: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SessionMetadata {
  sessionId: string;
  startTime: string;
  model?: string;
  workspace?: string;
}

/**
 * Sanitize a directory name for use in file paths
 * Replaces invalid characters and limits length
 */
function sanitizeDirName(name: string): string {
  // Replace invalid filesystem characters
  let sanitized = name
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\\/g, '_')
    .replace(/\//g, '_');

  // Limit length to avoid path too long issues
  if (sanitized.length > 100) {
    sanitized = sanitized.slice(0, 100);
  }

  // Remove trailing dots and spaces (invalid on Windows)
  sanitized = sanitized.replace(/[.\s]+$/, '');

  return sanitized || 'unnamed';
}

/**
 * Get workspace folder name from full path
 * Creates a unique identifier for the workspace
 * Format: E--projects-duya (drive letter + path segments joined by --)
 */
function getWorkspaceFolderName(workspacePath: string): string {
  const normalized = path.normalize(workspacePath);

  // Parse drive letter and path parts
  const parsed = path.parse(normalized);
  let parts: string[] = [];

  // Handle Windows drive letter (e.g., E:\)
  if (parsed.root && parsed.root.length > 1) {
    const drive = parsed.root[0].toUpperCase();
    parts.push(drive);
  }

  // Split the rest of the path
  const dirParts = normalized
    .replace(parsed.root, '')
    .split(path.sep)
    .filter(p => p && p !== '.');

  parts = parts.concat(dirParts);

  // Sanitize each part and join with --
  return parts.map(p => sanitizeDirName(p)).join('--');
}

/**
 * Format timestamp for filename (compact format)
 */
function formatTimestampForFilename(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * Get the base CLI sessions directory
 */
export function getCliSessionsDir(): string {
  return path.join(homedir(), '.duya', 'cli_sessions');
}

/**
 * Get the session log file path based on workspace
 */
export function getSessionLogPath(workspace?: string): string {
  const sessionsDir = getCliSessionsDir();

  if (!workspace) {
    // Default to 'default' folder if no workspace specified
    return path.join(sessionsDir, 'default', `${formatTimestampForFilename(new Date())}.log`);
  }

  const workspaceFolder = getWorkspaceFolderName(workspace);
  const timestamp = formatTimestampForFilename(new Date());

  return path.join(sessionsDir, workspaceFolder, `${timestamp}.log`);
}

/**
 * Ensure the directory exists
 */
function ensureDir(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    // If we can't create the directory, log to stderr but don't crash
    console.error(`[SessionLogger] Warning: Could not create directory ${dirPath}:`, err);
  }
}

/**
 * Format a timestamp for log entries
 */
function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Format a log entry as a string
 */
function formatLogEntry(entry: SessionLogEntry): string {
  const meta = entry.metadata ? ` [${JSON.stringify(entry.metadata)}]` : '';
  return `[${entry.timestamp}] [${entry.type.toUpperCase()}] ${entry.content}${meta}`;
}

/**
 * Session logger class
 */
export class SessionLogger {
  private logPath: string;
  private sessionId: string;
  private startTime: Date;
  private logStream: fs.WriteStream | null = null;
  private workspace?: string;

  constructor(sessionId?: string, workspace?: string) {
    this.sessionId = sessionId || `session-${Date.now()}`;
    this.startTime = new Date();
    this.workspace = workspace;
    this.logPath = getSessionLogPath(workspace);
  }

  /**
   * Get the session log file path
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Get the log directory for this session
   */
  getLogDirectory(): string {
    return path.dirname(this.logPath);
  }

  /**
   * Get session metadata
   */
  getMetadata(): SessionMetadata {
    return {
      sessionId: this.sessionId,
      startTime: this.startTime.toISOString(),
      workspace: this.workspace,
    };
  }

  /**
   * Open the log file for appending
   */
  open(): void {
    if (this.logStream) {
      return;
    }

    try {
      // Ensure the parent directory exists
      const dir = path.dirname(this.logPath);
      ensureDir(dir);

      // Check if directory was created successfully
      if (!fs.existsSync(dir)) {
        console.error(`[SessionLogger] Warning: Directory ${dir} does not exist, logging disabled`);
        return;
      }

      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf-8' });
    } catch (err) {
      console.error(`[SessionLogger] Warning: Could not open log file ${this.logPath}:`, err);
      this.logStream = null;
    }
  }

  /**
   * Close the log file
   */
  close(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  /**
   * Write a log entry
   */
  private write(entry: SessionLogEntry): void {
    const line = formatLogEntry(entry) + '\n';
    if (this.logStream) {
      this.logStream.write(line);
    }
    // Also write synchronously if stream is not open (for error logging before open)
    else {
      const dir = path.dirname(this.logPath);
      ensureDir(dir);
      fs.appendFileSync(this.logPath, line, 'utf-8');
    }
  }

  /**
   * Log user input
   */
  logUser(content: string, metadata?: Record<string, unknown>): void {
    this.write({
      timestamp: formatTimestamp(),
      type: 'user',
      content,
      metadata,
    });
  }

  /**
   * Log assistant response
   */
  logAssistant(content: string, metadata?: Record<string, unknown>): void {
    this.write({
      timestamp: formatTimestamp(),
      type: 'assistant',
      content,
      metadata,
    });
  }

  /**
   * Log system event
   */
  logSystem(content: string, metadata?: Record<string, unknown>): void {
    this.write({
      timestamp: formatTimestamp(),
      type: 'system',
      content,
      metadata,
    });
  }

  /**
   * Log tool usage
   */
  logTool(name: string, input: unknown, output?: string): void {
    const content = `Tool: ${name}\nInput: ${JSON.stringify(input)}${output ? `\nOutput: ${output}` : ''}`;
    this.write({
      timestamp: formatTimestamp(),
      type: 'tool',
      content,
    });
  }

  /**
   * Log error
   */
  logError(error: string | Error, metadata?: Record<string, unknown>): void {
    const content = error instanceof Error ? `${error.message}\n${error.stack}` : error;
    this.write({
      timestamp: formatTimestamp(),
      type: 'error',
      content,
      metadata,
    });
  }

  /**
   * Log session start
   */
  logSessionStart(metadata?: Partial<SessionMetadata>): void {
    this.open();
    this.logSystem(`Session started: ${this.sessionId}`, {
      ...this.getMetadata(),
      ...metadata,
    });
  }

  /**
   * Log session end
   */
  logSessionEnd(reason?: string): void {
    this.logSystem(`Session ended${reason ? `: ${reason}` : ''}`, {
      duration: `${Date.now() - this.startTime.getTime()}ms`,
    });
    this.close();
  }
}

// Default global logger instance
let globalLogger: SessionLogger | null = null;

/**
 * Get or create the global session logger
 */
export function getGlobalSessionLogger(): SessionLogger {
  if (!globalLogger) {
    globalLogger = new SessionLogger();
  }
  return globalLogger;
}

/**
 * Initialize the global session logger
 */
export function initSessionLogger(sessionId?: string, workspace?: string): SessionLogger {
  if (globalLogger) {
    globalLogger.close();
  }
  globalLogger = new SessionLogger(sessionId, workspace);
  return globalLogger;
}

/**
 * Close and cleanup the global session logger
 */
export function closeSessionLogger(): void {
  if (globalLogger) {
    globalLogger.close();
    globalLogger = null;
  }
}

/**
 * List all available session files
 * Returns a map of workspace -> session files
 */
export function listSessions(): Record<string, string[]> {
  const sessionsDir = getCliSessionsDir();
  const result: Record<string, string[]> = {};

  if (!fs.existsSync(sessionsDir)) {
    return result;
  }

  const workspaces = fs.readdirSync(sessionsDir);

  for (const workspace of workspaces) {
    const workspacePath = path.join(sessionsDir, workspace);

    if (fs.statSync(workspacePath).isDirectory()) {
      const files = fs.readdirSync(workspacePath)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse(); // Most recent first

      if (files.length > 0) {
        result[workspace] = files;
      }
    }
  }

  return result;
}

/**
 * Read a specific session file
 */
export function readSession(workspace: string, filename: string): string | null {
  const sessionsDir = getCliSessionsDir();
  const filePath = path.join(sessionsDir, workspace, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, 'utf-8');
}
