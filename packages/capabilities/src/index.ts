/**
 * `@duya/capabilities` — capability implementations for Duya.
 *
 * Slice 1 (plan 610 A8): the filesystem capability. Everything here was
 * moved from `packages/agent/src/{tool,permissions,utils}` and the agent now
 * consumes it through byte-compatible shims at the old import paths.
 *
 * Boundary discipline (plan 610 / 587 §2):
 * - No Goal / Task / Session lifecycle knowledge (gate G23).
 * - No imports from `@duya/agent` — the dependency edge only points this way.
 * - The caller context is a narrow structural type (`contracts`), so the
 *   agent's wide `ToolUseContext` stays assignable without casts.
 * - `@duya/tooling` is used for the `ToolContributor` DECLARATION only; the
 *   registry mechanism remains in the agent, as tooling's contract requires.
 *
 * The barrel deliberately does NOT export `utils/windowsPaths.js` (its
 * `posixPathToWindowsPath` collides with `utils/path.ts`'s) — that module
 * stays agent-local because only agent tests consume it.
 */

// Contracts — the pure tool vocabulary.
export * from './contracts/index.js';
export * from './BrowserTool/index.js';
export * from './BrowserTool/ports.js';

// BaseTool — the abstract tool base classes and execution error types.
// The explicit class export shadows the `BaseTool` interface contributed by
// the contracts star-export (ESM: explicit exports win over `export *`).
export {
  BaseTool,
  StreamingBaseTool,
  ToolExecutionError,
  ToolValidationError,
  ToolPermissionError,
  PermissionRequiredError,
} from './BaseTool.js';

// Filesystem capability — the six FS tools.
export {
  ReadTool,
  readFileContent,
  validateReadInput,
} from './ReadTool/ReadTool.js';
export type { ReadInput } from './ReadTool/ReadTool.js';
export { WriteTool } from './WriteTool/WriteTool.js';
export { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
export {
  GlobTool,
  globTool,
  executeGlob,
  splitAbsoluteGlob,
  isPathSafe,
  isPatternSafe,
  parseGitignore,
} from './GlobTool/GlobTool.js';
export {
  GrepTool,
  parseRipgrepLine,
  isSensitiveFilename,
  validateGrepInput,
} from './GrepTool/GrepTool.js';
export {
  ApplyPatchTool,
  applyPatchTool,
  parseCodexPatch,
  applyHunkToLines,
} from './ApplyPatchTool/ApplyPatchTool.js';

// Shared filesystem state — read-state ledger, mutation queue, snapshots.
export {
  computeContentSha,
  recordFileRead,
  getFileReadState,
  invalidateFileRead,
  clearFileReadState,
} from './file-read-state.js';
export type { FileReadStateEntry, FileReadStateInput } from './file-read-state.js';
export { withFileMutationQueue } from './file-mutation-queue.js';
export { withFileSnapshot } from './file-snapshot.js';
export type { WithFileSnapshotResult } from './file-snapshot.js';
export { FileSnapshotStore, sha256Of, getSnapshotRootDir } from './file-snapshot-store.js';

// Permissions — vocabulary + policy (moved from the agent).
export * from './permissions/index.js';

// App server — the host-owned, in-process MCP server (`duya_app`).
// Plan 616: first-party product capabilities (canvas / bot / browser)
// speak the MCP contract so they reach the model through the same
// pipeline as external MCP servers.
export {
  createInProcessAppServer,
} from './AppServer/in-process-app-server.js';
export type {
  AppServerTool,
  AppServerToolDefinition,
  InProcessAppServer,
  InProcessAppServerOptions,
} from './AppServer/in-process-app-server.js';
export {
  withAppToolContext,
  currentAppToolContext,
} from './AppServer/app-tool-context.js';
export type { AppToolContext } from './AppServer/app-tool-context.js';
export {
  DUYA_APP_SERVER_NAME,
  DUYA_APP_TOOL_PREFIX,
  resolveAppToolBaseName,
  isAppToolName,
} from './AppServer/app-tool-namespace.js';

// Tooling projection — the `tools`-slot contributor declarations.
export { createFileSystemToolContributors } from './fs-contributors.js';

// Shell environment discovery and command-line construction.
export * from './utils/shellDetector.js';
export * from './utils/shell/providers.js';

// Shell command capability. Host-owned process tracking is injected through
// ShellCommandRuntimePorts; this package owns validation, policy projection,
// shell resolution, output shaping and tool metadata.
export {
  BashTool,
  BASH_MAX_OUTPUT_CHARS,
  BASH_MAX_OUTPUT_LINES,
  buildSanitizedBashEnv,
  truncateShellOutput,
  validateBashInput,
} from './ShellCommandTool/BashTool.js';
export type { BashToolInput, ShellCommandToolConfig, TruncatedShellOutput } from './ShellCommandTool/BashTool.js';
export {
  DEFAULT_POWERSHELL_TOOL_CONFIG,
  PowerShellTool,
  checkPowerShellSecurity,
  isReadOnlyPowerShellCommand,
} from './ShellCommandTool/PowerShellTool.js';
export * from './ShellCommandTool/constants.js';
export * from './ShellCommandTool/ports.js';
export { parsePlainRmCommand, moveToRecycleBin } from './ShellCommandTool/safe-rm.js';
export { raceCompletionWithSoftYield } from './ShellCommandTool/soft-yield.js';
export * from './utils/shell/intelligence.js';

// User interaction capability. The Agent compatibility layer still owns
// permission transport and pending-answer lifecycle until Host/Runtime takes
// over tool invocation.
export {
  AskUserQuestionTool,
  askUserQuestionTool,
  askUserQuestionInputSchema,
  storePendingAnswer,
  clearPendingAnswer,
  takePendingAnswer,
} from './AskUserQuestionTool/AskUserQuestionTool.js';
export type { AskUserQuestionInput } from './AskUserQuestionTool/AskUserQuestionTool.js';
export {
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_CHIP_WIDTH,
  ASK_USER_QUESTION_TOOL_PROMPT,
  DESCRIPTION as ASK_USER_QUESTION_DESCRIPTION,
} from './AskUserQuestionTool/prompt.js';

// Memory-related tools depend on injected file access; Agent's old import
// paths provide the current Node filesystem adapter for Desktop and CLI.
export { MemoryWriteTool, validateMemoryContent } from './MemoryTools/MemoryWriteTool.js';
export { WriteStage1PolicyTool } from './MemoryTools/WriteStage1PolicyTool.js';
export type { MemoryToolFilePort } from './MemoryTools/ports.js';

// Session todo tool. The session-store resolver stays host-bound and is
// supplied by the temporary Agent compatibility adapter.
export { TodoTool, TODO_TOOL_NAME, LEGACY_TODO_WIRE_NAMES } from './TodoTool/TodoTool.js';
export type { TodoItem, TodoUpdate, TodoWriteSuccess, TodoTaskStore, TodoTaskStoreResolver } from './TodoTool/TodoTool.js';

// Project summary and module-resource capabilities.
export { BriefTool, briefTool } from './BriefTool/BriefTool.js';
export { BRIEF_TOOL_NAME } from './BriefTool/constants.js';
export type { BriefWorkspacePort, BriefDirectoryEntry } from './BriefTool/ports.js';
export { ModuleTool, moduleTool, MODULE_TOOL_NAME } from './ModuleTool/ModuleTool.js';

// Image generation tool contract; provider configuration and generation
// remain injected by current host adapters so CLI image commands can share it.
export {
  ImageGenerateTool,
  IMAGE_GENERATE_TOOL_NAME,
  DESCRIPTION as IMAGE_GENERATE_DESCRIPTION,
} from './ImageGenerateTool/ImageGenerateTool.js';
export type {
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageGenerationPortResult,
  ImageGenerationQuality,
} from './ImageGenerateTool/ports.js';

// Vision analysis accepts host-owned image loading and model callbacks through
// a narrow port; Agent currently adapts its attachment and analyzer context.
export { VisionTool } from './VisionTool/VisionTool.js';
export type {
  ResolvedVisionImageSource,
  VisionAnalysisPort,
  VisionAnalyzeCallback,
  VisionImageSourceRequest,
} from './VisionTool/ports.js';

// Message reaction behavior is capability-owned; transcript reads/writes are
// supplied by the Agent adapter until Host owns the interaction bridge.
export {
  collectReactions,
  ReactToMessageTool,
  resolveReactToMessage,
} from './ReactToMessageTool/ReactToMessageTool.js';
export type {
  ReactionDescriptor,
  ReactToMessageInput,
  ResolvedReaction,
} from './ReactToMessageTool/ReactToMessageTool.js';
export {
  MAX_EMOJI_CHARS,
  REACT_TO_MESSAGE_TOOL_NAME,
} from './ReactToMessageTool/constants.js';
export type { ReactToMessageErrorCode } from './ReactToMessageTool/constants.js';
export type {
  AppendReactionInput,
  ReactToMessageInvocationContext,
  ReactToMessagePort,
  ReactToMessageTranscriptRow,
} from './ReactToMessageTool/ports.js';
