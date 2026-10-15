import type {
  CreateSecretPendingInput,
  CreateWidgetPendingInput,
  CursorAgentRunInput,
  MarkSecretProvidedInput,
  UpdateCursorAgentRunInput,
  UpdateWidgetResponseInput,
} from '@duya/agent-protocol/send-message-state';
import type { SqliteDatabase } from './sqlite-connection.js';
import {
  createSecretPending,
  createWidgetPending,
  markSecretProvided,
  updateCursorAgentRun,
  updateWidgetResponse,
  upsertCursorAgentRun,
} from './send-message-state.js';

/** Data-owned writes for the side tables backing interactive message cards. */
export class SendMessageStateStore {
  constructor(private readonly db: SqliteDatabase) {}

  createWidgetPending(input: CreateWidgetPendingInput): void {
    createWidgetPending(this.db, input);
  }

  updateWidgetResponse(input: UpdateWidgetResponseInput): void {
    updateWidgetResponse(this.db, input);
  }

  upsertCursorAgentRun(input: CursorAgentRunInput): void {
    upsertCursorAgentRun(this.db, input);
  }

  updateCursorAgentRun(input: UpdateCursorAgentRunInput): void {
    updateCursorAgentRun(this.db, input);
  }

  createSecretPending(input: CreateSecretPendingInput): void {
    createSecretPending(this.db, input);
  }

  markSecretProvided(input: MarkSecretProvidedInput): void {
    markSecretProvided(this.db, input);
  }
}
