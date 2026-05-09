/**
 * PermissionBroker - Bridge permission requests between Agent and external platforms
 *
 * When the Agent requests permission for a tool execution, this broker:
 * 1. Creates a platform message with inline buttons (Allow / Deny / Allow Once)
 * 2. Parses button callback data when the user clicks
 * 3. Forwards the decision back to Main Process
 */

import type { NormalizedReply, PermissionDecision } from './types.js';

export class PermissionBroker {
  /**
   * Create a permission request reply with inline buttons
   */
  createPermissionReply(request: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): NormalizedReply {
    const { id, toolName, toolInput } = request;
    const inputPreview = JSON.stringify(toolInput, null, 2).slice(0, 300);

    return {
      type: 'permission_request',
      text: [
        '**Permission Request**',
        '',
        `Tool: \`${toolName}\``,
        `Input:`,
        '```',
        inputPreview,
        '```',
      ].join('\n'),
      buttons: [
        { text: '✅ Allow', callbackData: `perm:allow:${id}` },
        { text: '⚠️ Allow Once', callbackData: `perm:allow_once:${id}` },
        { text: '❌ Deny', callbackData: `perm:deny:${id}` },
      ],
    };
  }

  /**
   * Parse inline button callback data into a permission decision
   */
  parseCallback(callbackData: string): PermissionDecision | null {
    const match = callbackData.match(/^perm:(allow|allow_once|deny):(.+)$/);
    if (!match) return null;

    return {
      permissionId: match[2],
      decision: match[1] as 'allow' | 'allow_once' | 'deny',
    };
  }
}
