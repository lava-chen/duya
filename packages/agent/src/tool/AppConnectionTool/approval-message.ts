/** Compatibility re-export for Agent callers; approval rendering is pure capability behavior. */
export {
  APPROVAL_TEMPLATE_SCHEMA_VERSION,
  buildToolParamsDisplay,
  renderConnectorApprovalFromDescriptor,
  renderConnectorApprovalMessage,
} from '@duya/capabilities/AppConnectionTool/approval-message';
export type { RenderedApproval } from '@duya/capabilities/AppConnectionTool/approval-message';
