import { MessageLog as DataMessageLog } from '@duya/data/message-log';
import type { MessageLogLogger, MessageLogPorts } from '@duya/data/message-log';
import type { SqliteDatabase } from '@duya/data/core-database';
import { getLogger, LogComponent } from '../../logging/logger';
import { BOT_SESSION_ID_PREFIX, parseAgentIdFromBotSession } from '../../wake/bot-session-id';
import { getBotSessionLogPath, getBotSessionsDir } from '../../config/agent-paths';

export {
  BOT_ARCHIVE_HARD_LIMIT_BYTES,
  BOT_ARCHIVE_SOFT_LIMIT_BYTES,
  NON_BOT_ROTATION_THRESHOLD_BYTES,
  enforceBotArchiveCap,
  applyRebases,
  emitRebaseNewMessages,
  effectiveMessageTimeline,
  validateImportLines,
  remapImportNamespace,
  shiftRebaseBounds,
  ImportValidationError,
} from '@duya/data/message-log';
export type {
  RolloutLine,
  MessageEventKind,
  EventKind,
  NewEvent,
  StoredEvent,
  TimelineEntryRow,
  SearchTextOptions,
  SearchHit,
  RotationOptions,
  RolloutExportResult,
  ReconcileStats,
  ImportResult,
} from '@duya/data/message-log';

function createDesktopLogger(): MessageLogLogger {
  const logger = getLogger();
  return {
    info: (message, data, component) =>
      logger.info(message, data, component ?? LogComponent.DB),
    warn: (message, data, component) =>
      logger.warn(message, data, component ?? LogComponent.DB),
    error: (message, data, component) =>
      logger.error(message, undefined, data, component ?? LogComponent.DB),
  };
}

export function createDesktopMessageLogPorts(): MessageLogPorts {
  return {
    botSessionIdPrefix: BOT_SESSION_ID_PREFIX,
    parseBotSessionId: parseAgentIdFromBotSession,
    getBotSessionLogPath,
    getBotSessionsDir,
    logger: createDesktopLogger(),
    logComponent: LogComponent.DB,
    processLogComponent: LogComponent.AgentProcess,
  };
}

/** Desktop compatibility adapter; the durable implementation lives in @duya/data. */
export class MessageLog extends DataMessageLog {
  constructor(db: SqliteDatabase, rootDir: string) {
    super(db, rootDir, createDesktopMessageLogPorts());
  }
}
