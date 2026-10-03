/**
 * `@duya/agent-protocol/transcript` — the transcript vocabulary, as a subpath.
 *
 * ## Why a subpath and not the main entry
 *
 * The main entry already exports `TokenUsage`, `UsageCall`, `StopReason`,
 * `TextContent`, `ThinkingContent`, `ToolUse`, `ToolResult` and
 * `MessageContent` — the EVENT vocabulary from `../events/payloads.ts`. Those
 * are not the same shapes (see `../events/payloads.ts` and `./content.ts` for
 * the field-by-field differences), so re-exporting this module's identically
 * named types from the main entry would be a duplicate-identifier error.
 *
 * Renaming one side to resolve that would rename a type in every consumer's
 * source, which is a breaking change disguised as a cleanup. The subpath keeps
 * the names exactly as `@duya/ai` has always exported them, which is what makes
 * the compatibility shim a real re-export rather than a rename.
 *
 * It also matches this package's own stated rule: `legacy/` and `testing/` are
 * subpaths precisely so they cannot quietly become permanent parts of the main
 * surface. Nothing here is re-exported from the main entry, by design.
 *
 * ## Dependency direction
 *
 * This package stays a leaf. `transcript/` imports nothing outside
 * `agent-protocol` — no host, no database, no provider SDK, no tool registry.
 * `test/01-import-graph.test.ts` enforces that. The direction of the new edge
 * is `ai -> agent-protocol`, never the reverse.
 *
 * @deprecated Use the event vocabulary from `@duya/agent-protocol` for new
 * code. Removal task 587-T3-1-REMOVE-TRANSCRIPT, gated on the compatibility
 * window described in `MIGRATION.md`.
 */

export type {
  ApiFormat,
  MessageRole,
  MessageContentType,
  MessageContentTag,
  DeclaredMessageContentTag,
  MessageContentUnionIsComplete,
  StopReasonIsComplete,
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  ProviderBlockContent,
  MessageContent,
  Message,
  AssistantMessage,
  ProviderResponseMeta,
  TokenUsage,
  UsageCall,
  StopReason,
} from './content.js';

export {
  MESSAGE_CONTENT_TYPES,
  MESSAGE_CONTENT_UNION_IS_COMPLETE,
  STOP_REASONS,
  STOP_REASON_IS_COMPLETE,
} from './content.js';

export type {
  ToolGroupProgressSource,
  ToolUse,
  ToolResultMetadata,
  ToolResultImage,
  ToolResultWire,
  DeferredToolExtras,
  ToolResultContentParts,
} from './tool-result.js';

export type {
  ConnectorToolParamsDisplayEntry,
  PermissionRequestEvent,
  AgentProgressEvent,
  HookEventPayload,
} from './permission-progress.js';

export { AGENT_PROGRESS_TYPES, PERMISSION_REQUEST_MODES } from './permission-progress.js';

export type { FieldClass, Classified } from './classification.js';

export {
  MESSAGE_FIELDS,
  TEXT_CONTENT_FIELDS,
  IMAGE_CONTENT_FIELDS,
  TOOL_USE_CONTENT_FIELDS,
  TOOL_RESULT_CONTENT_FIELDS,
  THINKING_CONTENT_FIELDS,
  PROVIDER_BLOCK_CONTENT_FIELDS,
  ASSISTANT_MESSAGE_FIELDS,
  TOKEN_USAGE_FIELDS,
  USAGE_CALL_FIELDS,
  STOP_REASON_MEMBERS,
  TOOL_RESULT_WIRE_FIELDS,
  DEFERRED_TOOL_EXTRAS_FIELDS,
  TOOL_USE_FIELDS,
  TOOL_RESULT_METADATA_NAMED_FIELDS,
  TOOL_RESULT_METADATA_DIVERGENCE,
  PERMISSION_REQUEST_EVENT_FIELDS,
  AGENT_PROGRESS_EVENT_FIELDS,
  HOOK_EVENT_PAYLOAD_FIELDS,
  FIELD_CLASSIFICATION,
  FORBIDDEN_ON_WIRE,
  DECLARED_FIELD_DIVERGENCES,
  CLASS_RATIONALE,
} from './classification.js';
