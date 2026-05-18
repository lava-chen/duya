type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Format as human-readable line (used for stderr error output).
 */
function formatEntry(entry: LogEntry): string {
  const base = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.component}] ${entry.msg}`;
  if (entry.data && Object.keys(entry.data).length > 0) {
    return `${base} ${JSON.stringify(entry.data)}`;
  }
  return base;
}

/**
 * Format as JSON line (used for stdout structured logging).
 * Main process can parse the level field and route to the correct logger.
 */
function formatJsonLine(entry: LogEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    level: entry.level,
    component: entry.component,
    msg: entry.msg,
    ...(entry.data && Object.keys(entry.data).length > 0 ? { data: entry.data } : {}),
  });
}

export function createLogger(component: string) {
  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
    };
    if (data) entry.data = data;

    // All logs go to stdout as JSON lines for Main to parse
    process.stdout.write(formatJsonLine(entry) + '\n');
  }

  return {
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
    error: (msg: string, err?: Error, data?: Record<string, unknown>) => {
      const entryData = data || {};
      if (err) {
        entryData.errorMessage = err.message;
        entryData.stack = err.stack;
      }
      log('error', msg, entryData);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

export const logger = createLogger('agent-server');
export const httpLogger = createLogger('agent-server:http');
export const workerLogger = createLogger('agent-server:worker');
export const sessionLogger = createLogger('agent-server:session');
