/**
 * Professional Logger for Agent Package
 *
 * Features:
 * - Structured JSON logging with context support
 * - File-based logging for agent processes
 * - Log level filtering
 * - Trace ID support for distributed tracing
 * - IPC forwarding to main process (when running in Electron)
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  component?: string;
  traceId?: string;
  context?: LogContext;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  duration?: number;
}

export interface LoggerConfig {
  level: LogLevel;
  format: 'text' | 'json';
  logDir: string;
  logFile: string;
  console: boolean;
  forwardToMain: boolean;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

class AgentLogger {
  private config: LoggerConfig;
  private currentTraceId: string | null = null;
  private isElectron: boolean;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.isElectron = process.env.DUYA_AGENT_MODE === 'true';

    const sessionId = process.env.SESSION_ID || 'unknown';
    const defaultLogDir = path.join(homedir(), '.duya', 'logs', 'agent');

    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || 'INFO',
      format: 'text',
      logDir: defaultLogDir,
      logFile: `agent-${sessionId}.log`,
      console: !this.isElectron,
      forwardToMain: this.isElectron,
      ...config,
    };

    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    try {
      if (!fs.existsSync(this.config.logDir)) {
        fs.mkdirSync(this.config.logDir, { recursive: true });
      }
    } catch (err) {
      console.error('[AgentLogger] Failed to create log directory:', err);
    }
  }

  private getTimestamp(): string {
    return new Date().toISOString();
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.level];
  }

  private formatEntry(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry) + '\n';
    }

    let line = `[${entry.timestamp}] [${entry.level}]`;

    if (entry.component) {
      line += ` [${entry.component}]`;
    }

    if (entry.traceId) {
      line += ` [${entry.traceId}]`;
    }

    line += ` ${entry.message}`;

    if (entry.duration !== undefined) {
      line += ` (${entry.duration}ms)`;
    }

    if (entry.context && Object.keys(entry.context).length > 0) {
      try {
        line += ` ${JSON.stringify(entry.context)}`;
      } catch {
        line += ' [Context serialization failed]';
      }
    }

    if (entry.error) {
      line += `\n  Error: ${entry.error.message}`;
      if (entry.error.stack) {
        line += `\n  Stack: ${entry.error.stack}`;
      }
      if (entry.error.code) {
        line += `\n  Code: ${entry.error.code}`;
      }
    }

    return line + '\n';
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    options: {
      component?: string;
      context?: LogContext;
      error?: Error;
      duration?: number;
    } = {}
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: this.getTimestamp(),
      level,
      message,
      component: options.component,
      traceId: this.currentTraceId || undefined,
      context: options.context,
      duration: options.duration,
    };

    if (options.error) {
      entry.error = {
        message: options.error.message,
        stack: options.error.stack,
        code: (options.error as { code?: string }).code,
      };
    }

    return entry;
  }

  private write(entry: LogEntry): void {
    const formatted = this.formatEntry(entry);

    // Console output
    if (this.config.console) {
      const consoleMethod =
        entry.level === 'ERROR' || entry.level === 'FATAL'
          ? console.error
          : entry.level === 'WARN'
            ? console.warn
            : entry.level === 'DEBUG'
              ? console.debug
              : console.log;
      consoleMethod(formatted.trim());
    }

    // File output
    try {
      const logPath = path.join(this.config.logDir, this.config.logFile);
      fs.appendFileSync(logPath, formatted, 'utf-8');
    } catch (err) {
      // Silently fail to avoid infinite loops
    }

    // Forward to main process if in Electron mode
    if (this.config.forwardToMain && process.send) {
      try {
        process.send({
          type: 'log',
          entry,
        });
      } catch {
        // Ignore send errors
      }
    }
  }

  // Trace ID management
  setTraceId(traceId: string | null): void {
    this.currentTraceId = traceId;
  }

  withTrace<T>(traceId: string, fn: () => T): T {
    const prevTraceId = this.currentTraceId;
    this.currentTraceId = traceId;
    try {
      return fn();
    } finally {
      this.currentTraceId = prevTraceId;
    }
  }

  async withTraceAsync<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    const prevTraceId = this.currentTraceId;
    this.currentTraceId = traceId;
    try {
      return await fn();
    } finally {
      this.currentTraceId = prevTraceId;
    }
  }

  // Public logging API
  debug(message: string, context?: LogContext, component?: string): void {
    if (!this.shouldLog('DEBUG')) return;
    this.write(this.createLogEntry('DEBUG', message, { component, context }));
  }

  log(message: string, context?: LogContext, component?: string): void {
    if (!this.shouldLog('INFO')) return;
    this.write(this.createLogEntry('INFO', message, { component, context }));
  }

  info(message: string, context?: LogContext, component?: string): void {
    if (!this.shouldLog('INFO')) return;
    this.write(this.createLogEntry('INFO', message, { component, context }));
  }

  warn(message: string, context?: LogContext, component?: string): void {
    if (!this.shouldLog('WARN')) return;
    this.write(this.createLogEntry('WARN', message, { component, context }));
  }

  error(message: string, error?: Error, context?: LogContext, component?: string): void {
    if (!this.shouldLog('ERROR')) return;
    this.write(this.createLogEntry('ERROR', message, { component, context, error }));
  }

  fatal(message: string, error?: Error, context?: LogContext, component?: string): void {
    if (!this.shouldLog('FATAL')) return;
    this.write(this.createLogEntry('FATAL', message, { component, context, error }));
  }

  // Performance tracking
  time(label: string, component?: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.debug(`${label} completed`, { duration }, component);
    };
  }

  async timeAsync<T>(label: string, fn: () => Promise<T>, component?: string): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.debug(`${label} completed`, { duration }, component);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.error(`${label} failed`, error as Error, { duration }, component);
      throw error;
    }
  }

  // Configuration
  updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
    this.info('Logger configuration updated', { config: this.config }, 'AgentLogger');
  }

  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  // Get log file path
  getLogPath(): string {
    return path.join(this.config.logDir, this.config.logFile);
  }

  // Export logs
  exportLogs(): string {
    try {
      const logPath = path.join(this.config.logDir, this.config.logFile);
      if (fs.existsSync(logPath)) {
        return fs.readFileSync(logPath, 'utf-8');
      }
      return 'No logs available';
    } catch (error) {
      return `Failed to export logs: ${error}`;
    }
  }

  // Clear logs
  clearLogs(): boolean {
    try {
      const logPath = path.join(this.config.logDir, this.config.logFile);
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      this.info('Logs cleared', undefined, 'AgentLogger');
      return true;
    } catch (error) {
      console.error('[AgentLogger] Failed to clear logs:', error);
      return false;
    }
  }
}

// Singleton instance
let loggerInstance: AgentLogger | null = null;

export function initLogger(config?: Partial<LoggerConfig>): AgentLogger {
  if (!loggerInstance) {
    loggerInstance = new AgentLogger(config);
  }
  return loggerInstance;
}

export function getLogger(): AgentLogger {
  if (!loggerInstance) {
    return initLogger();
  }
  return loggerInstance;
}

// Utility to generate trace IDs
export function generateTraceId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Default logger instance for backward compatibility
export const logger = getLogger();

export default AgentLogger;
