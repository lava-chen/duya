/**
 * logger.ts — logging port for `@duya/browser`.
 *
 * The package must not depend on `@duya/agent` (that would invert the
 * dependency and defeat the extraction), and it must not use `console.*`
 * directly (see AGENTS.md "Logging"). So the engine declares a minimal
 * structural port and the host injects its own logger at wiring time.
 *
 * The port is intentionally shaped like `AgentLogger`
 * (`packages/agent/src/utils/logger.ts`): `debug/info/warn` take
 * `(message, context?, component?)` and `error` takes
 * `(message, error?, context?, component?)`. That makes the host logger
 * structurally assignable with no adapter object, and it keeps every
 * existing call site byte-identical after the move.
 */

export type LogContext = Record<string, unknown>;

/**
 * Minimal surface the engine actually uses. Declared structurally so any
 * host logger with these four methods satisfies it.
 */
export interface BrowserLogger {
  debug(message: string, context?: LogContext, component?: string): void;
  info(message: string, context?: LogContext, component?: string): void;
  warn(message: string, context?: LogContext, component?: string): void;
  error(message: string, error?: Error, context?: LogContext, component?: string): void;
}

/**
 * Component tag used by every call site in this package, so host-side log
 * filtering stays one grep (`component === 'BrowserTool'`).
 */
export const BROWSER_LOG_COMPONENT = 'BrowserTool';

/**
 * Fallback used when no host logger was injected (standalone CLI, unit
 * tests, a future MCP wrapper). Silent by default: a library that prints
 * to stdout pollutes the host's own output, and the degradation chain in
 * `backend-resolver.ts` already surfaces real problems to the user.
 */
const NOOP_LOGGER: BrowserLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let injected: BrowserLogger = NOOP_LOGGER;

/** Install the host logger. Called once by the agent adapter at wiring time. */
export function setBrowserLogger(logger: BrowserLogger | null): void {
  injected = logger ?? NOOP_LOGGER;
}

/** Current logger. Never null; falls back to a no-op sink. */
export function getBrowserLogger(): BrowserLogger {
  return injected;
}

/**
 * Drop-in replacement for the old `import { logger } from
 * '../../utils/logger.js'` call sites. Use it as `logger.warn(...)` so the
 * moved code is unchanged apart from the import specifier.
 */
export const logger: BrowserLogger = {
  debug: (message, context, component) => injected.debug(message, context, component),
  info: (message, context, component) => injected.info(message, context, component),
  warn: (message, context, component) => injected.warn(message, context, component),
  error: (message, error, context, component) => injected.error(message, error, context, component),
};
