/**
 * Structured logging boundary for OS context services.
 *
 * Host callers should inject their process logger. The fallback preserves
 * warning/error visibility for standalone parser and watcher use without
 * coupling this package to an application logger.
 */
export interface OSContextLogger {
  debug(message: string, context?: Record<string, unknown>, component?: string): void;
  info(message: string, context?: Record<string, unknown>, component?: string): void;
  warn(message: string, context?: Record<string, unknown>, component?: string): void;
  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
    component?: string,
  ): void;
}

function emitFallbackWarning(
  level: 'WARN' | 'ERROR',
  message: string,
  error?: Error,
  context?: Record<string, unknown>,
  component?: string,
): void {
  const detail = [component, message, context ? JSON.stringify(context) : undefined]
    .filter((part): part is string => Boolean(part))
    .join(' ');
  const warning = error
    ? new Error(`${level}: ${detail}: ${error.message}`)
    : new Error(`${level}: ${detail}`);
  if (error?.stack) warning.stack = `${warning.stack}\nCaused by: ${error.stack}`;
  process.emitWarning(warning);
}

/** Fallback used only when a caller does not provide its process logger. */
export const fallbackOSContextLogger: OSContextLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, context, component) =>
    emitFallbackWarning('WARN', message, undefined, context, component),
  error: (message, error, context, component) =>
    emitFallbackWarning('ERROR', message, error, context, component),
};
