import {
  consumeApprovedToolApproval,
  consumeToolApprovalById,
  createToolApproval,
  getToolApproval,
  listToolApprovalRules,
  listToolApprovalsBySession,
  resolveToolApproval,
  upsertToolApprovalRule,
  type ToolApprovalInput,
  type ToolApprovalRow,
} from '@duya/data/tool-approval-state';
import type {
  HostToolApproval,
  HostToolApprovalApiV1,
  HostToolApprovalInput,
} from '@duya/agent-protocol';

type MainDatabase = Parameters<typeof resolveToolApproval>[0];

function toHostToolApproval(row: ToolApprovalRow): HostToolApproval {
  return row;
}

function toDataInput(input: HostToolApprovalInput): ToolApprovalInput {
  return {
    id: input.id,
    messageId: input.messageId,
    sessionId: input.sessionId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    toolName: input.toolName,
    ...(input.toolInput === undefined ? {} : { toolInput: { ...input.toolInput } }),
  };
}

/** Compose the Host approval API over the main database handle it already owns. */
export function createHostToolApprovalApi(database: MainDatabase): HostToolApprovalApiV1 {
  return {
    async createToolApproval(input) {
      return toHostToolApproval(createToolApproval(database, toDataInput(input)));
    },
    async getToolApproval(id) {
      const row = getToolApproval(database, id);
      return row ? toHostToolApproval(row) : null;
    },
    async listToolApprovalsBySession(sessionId) {
      return listToolApprovalsBySession(database, sessionId).map(toHostToolApproval);
    },
    async resolveToolApproval(id, decision) {
      const result = resolveToolApproval(database, id, decision);
      return result ? { row: toHostToolApproval(result.row), claimed: result.claimed } : null;
    },
    async consumeApprovedToolApproval(input) {
      return consumeApprovedToolApproval(database, input.sessionId, input.toolName, input.inputHash);
    },
    async consumeToolApprovalById(id) {
      const row = consumeToolApprovalById(database, id);
      return row ? toHostToolApproval(row) : null;
    },
    async upsertToolApprovalRule(input) {
      upsertToolApprovalRule(database, input.scopeType, input.scopeId, input.toolName);
    },
    async listToolApprovalRules(input) {
      return listToolApprovalRules(database, input.scopeType, input.scopeId);
    },
  };
}
