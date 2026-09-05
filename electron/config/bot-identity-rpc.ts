/**
 * bot-identity-rpc.ts — Plan 481 amendment: main-process handler for the
 * `bot-identity:rpc` channel (update_state profile.set / avatar.set /
 * avatar.clear).
 *
 * The agent subprocess forwards the subaction envelope here
 * (agent-server-lifecycle.ts). This module:
 *
 *   1. BINDS the subaction to the SESSION'S bot identity. Bot sessions are
 *      `bot:<agentId>` (electron/wake/bot-session-id.ts) — the payload's
 *      actorAgentId is only accepted when it matches that binding, so a bot
 *      can never edit another agent's profile.json (the tool schema has no
 *      agentId parameter; this is the server-side enforcement of that).
 *   2. Validates the avatar color token against the canonical set and the
 *      avatar image (extension whitelist + size cap + magic bytes, via
 *      setBotAvatarImage) — unknown tokens / bad images are structured
 *      errors, not silent coercion.
 *   3. Writes the runtime identity through `updateBotProfileIdentity`
 *      (agents.ts), the same path the UI edit dialog uses. config.toml
 *      name/description are seed/fallback only (Plan 485 §2.4); title is
 *      host-managed and NOT model-editable.
 *
 * Never throws for expected conditions — the tool sees `success: false`
 * with a structured code, mirroring the memory-tier-rpc contract.
 */

import path from 'path';
import { getLogger, LogComponent } from '../logging/logger';
import { parseAgentIdFromBotSession } from '../wake/bot-session-id';
import {
  clearBotAvatarTokens,
  setBotAvatarImage,
  updateBotProfileIdentity,
  type BotIdentityInput,
} from './agents';
import { isValidAvatarColor } from './bot-avatar';

export interface BotIdentityRpcRequest {
  subaction: string;
  payload: Record<string, unknown>;
  sessionId?: string;
}

export interface BotIdentityRpcResult {
  success: boolean;
  outcome?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const SUBACTIONS = new Set(['profile.set', 'avatar.set', 'avatar.clear']);

/** Strip control characters / clamp string fields from the payload. */
function cleanString(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').trim().slice(0, maxLen) : '';
}

export function handleBotIdentityRpc(request: BotIdentityRpcRequest): Promise<BotIdentityRpcResult> {
  return Promise.resolve(handleSync(request));
}

function handleSync(request: BotIdentityRpcRequest): BotIdentityRpcResult {
  if (!SUBACTIONS.has(request.subaction)) {
    return {
      success: false,
      error: { code: 'INVALID_ACTION', message: `unknown bot-identity subaction: ${request.subaction}` },
    };
  }

  // ── Security binding: session `bot:<id>` === actor ──
  // Plain (non-bot) sessions have no identity to edit; update_state's
  // execute() already requires an agentProfileId, but the binding check
  // here is the authoritative server-side gate.
  const sessionAgentId = request.sessionId ? parseAgentIdFromBotSession(request.sessionId) : null;
  if (!sessionAgentId) {
    return {
      success: false,
      error: {
        code: 'NO_IDENTITY',
        message: 'Identity updates require a bot session (bot:<agentId>); this session has no bot identity bound.',
      },
    };
  }

  const actorAgentId = cleanString(request.payload.actorAgentId, 64);
  if (actorAgentId !== sessionAgentId) {
    getLogger().warn(
      'bot-identity:rpc actor/session mismatch rejected',
      { sessionId: request.sessionId ?? '', actorAgentId },
      LogComponent.AgentProcess,
    );
    return {
      success: false,
      error: {
        code: 'IDENTITY_MISMATCH',
        message: 'The calling identity does not match this session — you may only update your own profile.',
      },
    };
  }

  // ── Build the patch for the runtime identity writer ──
  let patch: BotIdentityInput;
  let avatarImagePath: string | null = null;
  if (request.subaction === 'profile.set') {
    const name = cleanString(request.payload.name, 64);
    const description = cleanString(request.payload.description, 300);
    if (!name && !description) {
      return {
        success: false,
        error: { code: 'INVALID_PAYLOAD', message: 'profile.set requires a name and/or description.' },
      };
    }
    patch = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  } else if (request.subaction === 'avatar.clear') {
    try {
      clearBotAvatarTokens(sessionAgentId);
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'WRITE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    getLogger().info(
      `Bot identity updated via update_state avatar.clear: '${sessionAgentId}'`,
      { agentId: sessionAgentId },
      LogComponent.AgentProcess,
    );
    return {
      success: true,
      outcome: { agentId: sessionAgentId, avatarColor: '', avatarImage: '' },
    };
  } else {
    // avatar.set — color token and/or image source path (e.g. the model's
    // own image_generate output). At least one must be present.
    const color = cleanString(request.payload.avatarColor, 32);
    const imagePath = cleanString(request.payload.avatarImagePath, 1024);
    if (!color && !imagePath) {
      return {
        success: false,
        error: { code: 'INVALID_PAYLOAD', message: 'avatar.set requires avatarColor and/or avatarImagePath.' },
      };
    }
    if (color && !isValidAvatarColor(color)) {
      return {
        success: false,
        error: {
          code: 'INVALID_AVATAR_COLOR',
          message: `Unknown avatarColor '${color}'. Valid: black|brown|red|orange|yellow|green|cyan|blue|violet|magenta|gray.`,
        },
      };
    }
    if (imagePath && !path.isAbsolute(imagePath)) {
      return {
        success: false,
        error: {
          code: 'INVALID_AVATAR_IMAGE',
          message: `avatarImagePath must be an absolute path to an image file (e.g. the path returned by image_generate), got '${imagePath}'.`,
        },
      };
    }
    patch = {
      ...(color ? { avatarColor: color } : {}),
    };
    avatarImagePath = imagePath || null;
  }

  try {
    if (avatarImagePath) {
      // Copy the image into the bot's agent directory first — it validates
      // extension/size/magic bytes and throws with a descriptive message.
      setBotAvatarImage(sessionAgentId, avatarImagePath);
    }
    const updated = updateBotProfileIdentity(sessionAgentId, patch);
    getLogger().info(
      `Bot identity updated via update_state ${request.subaction}: '${sessionAgentId}'`,
      { agentId: sessionAgentId },
      LogComponent.AgentProcess,
    );
    return {
      success: true,
      outcome: {
        agentId: sessionAgentId,
        name: updated?.name ?? sessionAgentId,
        description: updated?.description ?? '',
        avatarColor: updated?.avatarColor ?? '',
        avatarImage: updated?.avatarImage ?? '',
      },
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
