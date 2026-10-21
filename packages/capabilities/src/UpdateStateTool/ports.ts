import type { ToolUseContext } from '../contracts/tool.js';
import type { MemoryTier, TierEntryKind } from './constants.js';

export interface MemoryTierWritePayload {
  actorAgentId: string;
  tier: MemoryTier;
  action: 'write' | 'forget' | 'create' | 'join' | 'leave';
  fact: string;
  dedupeKey: string;
  project?: string;
  kind: TierEntryKind;
}

export interface BotIdentityPatchPayload {
  actorAgentId: string;
  subaction: 'profile.set' | 'avatar.set' | 'avatar.clear';
  name?: string;
  description?: string;
  avatarImagePath?: string;
  avatarColor?: string;
}

export interface MemoryTierBridgeResponse {
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface UpdateStateContext extends ToolUseContext {
  options?: ToolUseContext['options'] & {
    agentProfileId?: string | null;
  };
}

export type MemoryTierBridge = (
  payload: MemoryTierWritePayload,
  context?: UpdateStateContext,
) => Promise<MemoryTierBridgeResponse>;

export type BotIdentityBridge = (
  payload: BotIdentityPatchPayload,
  context?: UpdateStateContext,
) => Promise<MemoryTierBridgeResponse>;

/** Main-process persistence/identity RPCs are provided by Host. */
export interface UpdateStatePort {
  writeMemory(
    payload: MemoryTierWritePayload,
    context?: UpdateStateContext,
  ): Promise<MemoryTierBridgeResponse | null>;
  updateIdentity(
    payload: BotIdentityPatchPayload,
    context?: UpdateStateContext,
  ): Promise<MemoryTierBridgeResponse | null>;
}
