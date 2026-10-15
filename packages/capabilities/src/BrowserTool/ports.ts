/** Host services required by the browser capability. */

export interface BrowserToolLoggerPort {
  info(message: string, context?: Record<string, unknown>, component?: string): void;
  warn(message: string, context?: Record<string, unknown>, component?: string): void;
  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
    component?: string,
  ): void;
}

export interface BrowserToolHostPorts {
  /** True when the host renderer can create and drive a browser webview. */
  isRendererAvailable(): boolean;
  logger?: BrowserToolLoggerPort;
}

export const DEFAULT_BROWSER_TOOL_HOST_PORTS: BrowserToolHostPorts = {
  isRendererAvailable: () => false,
};

const silentLogger: BrowserToolLoggerPort = {
  info() {},
  warn() {},
  error() {},
};

let configuredLogger = silentLogger;

export function configureBrowserToolLogger(logger: BrowserToolLoggerPort | undefined): void {
  configuredLogger = logger ?? silentLogger;
}

/** Shared logger proxy used by CDP clients created below the tool facade. */
export const browserLogger: BrowserToolLoggerPort = {
  info: (message, context, component) => configuredLogger.info(message, context, component),
  warn: (message, context, component) => configuredLogger.warn(message, context, component),
  error: (message, error, context, component) => configuredLogger.error(message, error, context, component),
};
