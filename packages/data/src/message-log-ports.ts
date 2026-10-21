export interface MessageLogLogger {
  info(message: string, data?: Record<string, unknown>, component?: string): void;
  warn(message: string, data?: Record<string, unknown>, component?: string): void;
  error(message: string, data?: Record<string, unknown>, component?: string): void;
}

export interface MessageLogPathPorts {
  readonly botSessionIdPrefix: string;
  parseBotSessionId(sessionId: string): string | null;
  getBotSessionsDir(agentId: string, dataRoot: string): string;
  getBotSessionLogPath(agentId: string, dataRoot: string): string;
}

export interface MessageLogPorts extends MessageLogPathPorts {
  logger?: MessageLogLogger;
  logComponent?: string;
  processLogComponent?: string;
}
