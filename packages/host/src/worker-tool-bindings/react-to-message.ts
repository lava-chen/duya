/** Bind the capability to Host product services. */
import {
  ReactToMessageTool as CapabilityReactToMessageTool,
  type ReactToMessagePort,
} from '@duya/capabilities/react-to-message-tool';
import type { PermissionCheckResult, ToolContext } from '@duya/capabilities';
import { createWorkerReactToMessagePort } from '@duya/host/worker-tool-services/react-to-message';

export {
  collectReactions,
  resolveReactToMessage,
  type ReactToMessageInput,
  type ReactionDescriptor,
  type ResolvedReaction,
} from '@duya/capabilities/react-to-message-tool';

/** Legacy constructor shape stays no-argument for existing registrations. */
export class ReactToMessageTool extends CapabilityReactToMessageTool {
  constructor(port: ReactToMessagePort = createWorkerReactToMessagePort()) {
    super(port);
  }

  /** Preserve the legacy Agent gate; authorization policy stays outside Capabilities. */
  checkPermissions(_input: unknown, _context: ToolContext): PermissionCheckResult {
    return { allowed: true, reason: 'Emoji tapback (self-scoped, pre-approved).' };
  }
}

export const reactToMessageTool = new ReactToMessageTool();
