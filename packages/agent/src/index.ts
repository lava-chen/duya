/**
 * Public API for the @duya/agent package.
 *
 * This file is a pure barrel: it re-exports the public surface
 * (types, supporting modules, and the `duyaAgent` class) so that
 * consumers can import from a single entry point. The `duyaAgent`
 * class implementation lives in `./agent/DuyaAgent.ts`. Module-level
 * helpers (`extractTextFromContent`, `collectRecentImageAttachments`,
 * `buildBackgroundTaskNotification`, `buildAgentIdentityBlock`) live
 * alongside the class in `agent/DuyaAgent.ts` because they are only
 * used by it.
 */

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './types.js';
import type {
  AgentOptions,
  ChatOptions,
  ImageContent,
  Message,
  MessageContent,
  Tool,
  ToolUse,
  SSEEvent,
  SessionInfo,
  MCPServerConfig,
  MCPConnectionStatus,
  ToolUseContext,
  ToolResultContent,
  AgentProgressEvent,
} from './types.js';
import { PromptManager, asSystemPrompt, DEFAULT_PROMPT_PROFILE, getPromptProfileForAgentProfile, PromptsRegistry, resolvePromptSystemName } from './prompts/index.js';
import type { PromptSystem } from './prompts/index.js';
import { getMemoryManager } from './memory/index.js'
import { createMemoryReviewService } from './memory/index.js';
import { compactHistory } from './compact/compact.js';
import type { CompactResult, TokenEstimation } from './compact/compact.js';
import { estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD } from './compact/compact.js';
import { StreamingToolExecutor } from './tool/StreamingToolExecutor.js';
import type { CanUseToolFn } from './tool/StreamingToolExecutor.js';
import { createHasPermissionsToUseTool } from './permissions/permissions.js';
import type { ToolPermissionCheckContext } from './permissions/permissions.js';
// Compaction system exports
export type {
  CompactionStats,
  CompactionResult,
  CompactionStrategy,
  CompactionEvent,
  TokenBudget,
  TokenBudgetConfig,
  CompactOptions,
  CompactionManagerConfig,
} from './compact/index.js';
export {
  CompactionManager,
  createCompactionManager,
  createTokenBudget,
  MicroCompactStrategy,
  SessionMemoryCompactStrategy,
  SnipCompactStrategy,
  ReactiveCompactStrategy,
  estimateMessageTokens,
  estimateMessagesTokens,
  DEFAULT_BUDGET_CONFIG,
  COMPACTION_THRESHOLDS,
} from './compact/index.js';

export type { Message, Tool, ToolUse, SSEEvent, AgentOptions, ChatOptions, MCPServerConfig, MCPConnectionStatus, CompactResult, TokenEstimation };
export { compactHistory, estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD };

// 导出工具相关
export { ToolRegistry } from './tool/registry.js';
export { createBuiltinRegistry } from './tool/builtin.js';
export { StreamingToolExecutor } from './tool/StreamingToolExecutor.js';

// Sandbox exports
export { setSandboxEnabled, buildSandboxImage } from './sandbox/index.js';
export type {
  ToolStatus,
  TrackedTool,
  ToolProgress,
  ToolExecutionContext,
  ToolExecutionResult,
  MessageUpdate,
  CanUseToolFn,
  CanUseToolDecision,
} from './tool/StreamingToolExecutor.js';

// Export MCP related
export { MCPManager, MCPClient } from './mcp/index.js';
export { loadMCPConfigs, loadMCPConfigsFromSettings, getSettingsPath, validateMCPConfig } from './mcp/config.js';
export type { MCPConfigItem, MCPConfigLoadResult } from './mcp/config.js';
export { MCPStatusManager, getMCPStatusManager, resetMCPStatusManager } from './mcp/status.js';
export type { MCPStatusInfo, StatusChangeCallback } from './mcp/status.js';
export { CircuitBreaker, CircuitBreakerManager, getCircuitBreakerManager, resetCircuitBreakerManager, DEFAULT_CIRCUIT_CONFIG } from './mcp/circuit-breaker.js';
export type { CircuitState, CircuitBreakerConfig } from './mcp/circuit-breaker.js';
export { discoverMCPTools, registerMCPTools, getToolSource, isMCPTool, getToolsByServer } from './mcp/discovery.js';
export type { ToolDiscoveryResult, ToolRegistrationResult, ConflictStrategy } from './mcp/discovery.js';
export { MCPNotificationHandler, createNotificationHandler } from './mcp/notifications.js';
export type { NotificationHandlerOptions } from './mcp/notifications.js';

// 导出 Session 相关
export { SessionManager } from './session/index.js';
export type { SessionStore, SessionManagerOptions } from './session/index.js';

// 导出 Permissions 相关
export type {
  PermissionMode,
  PermissionBehavior,
  PermissionDecision,
  PermissionResult,
  PermissionRule,
  ToolPermissionContext,
} from './permissions/index.js';
export { createHasPermissionsToUseTool } from './permissions/permissions.js';
export type { ToolPermissionCheckContext } from './permissions/permissions.js';

// 导出 Prompt 相关
export { PromptManager, getPlatformHint, hasPlatformCapability, PLATFORM_HINTS } from './prompts/index.js';
export type { CommunicationPlatform } from './prompts/types.js';

// 导出 AGENTS.md 相关
export {
  AgentsMdManager,
  getAgentsMdManager,
  resetAgentsMdManager,
  createAgentsMdManager,
  loadAgentsMdFiles,
  buildAgentsMdPrompt,
  isAgentsMdFile,
} from './agentsmd/index.js';
export type {
  AgentsFileInfo,
  AgentsMemoryType,
  AgentsMdConfig,
} from './agentsmd/index.js';

// 导出 Skill 相关
export {
  SkillRegistry,
  getSkillRegistry,
  resetSkillRegistry,
  loadSkills,
  loadMcpSkills,
  getSkillDirectories,
  SkillManager,
  skillManage,
} from './skills/index.js';
export type {
  SkillArgument,
  SkillSource,
  SkillResult,
  SkillMetadata,
  SkillFrontmatter,
  BundledSkillDefinition,
  PromptSkill,
  SkillLoadOptions,
  SkillManageParams,
} from './skills/index.js';

// 导出 Task 相关
export {
  getDatabaseTaskStore,
  type Task,
  type TaskStatus,
  type TaskStore
} from './session/task-store.js';

// 导出 SelfImprover 相关
export {
  SelfImprover,
  getDefaultSelfImprover,
  resetDefaultSelfImprover,
} from './self-improver/SelfImprover.js';
export type { SkillReviewResult } from './self-improver/SelfImprover.js';

// Agent Profile exports
export type {
  AgentProfile,
  AgentProfileDbRow,
  ToolFilterContext,
  ToolFilterResult,
} from './agent-profile/index.js';
export {
  PRESET_AGENT_PROFILES,
  InMemoryAgentProfileService,
  getAgentProfileService,
  resetAgentProfileService,
  setAgentProfileService,
  rowToAgentProfile,
  profileToRow,
  filterTools,
  resolveAllowedTools,
  validateToolAccess,
  matchToolPattern,
  expandToolGroups,
  getEmojiForProfile,
  getColorForProfile,
  getIdentityLabel,
} from './agent-profile/index.js';

// Mode System exports
export { ModeRegistry, BaseMode } from './modes/index.js';
export type {
  ModeContext,
  ModeConstructor,
  ClarificationQuestion,
  ClarificationAnswer,
} from './modes/index.js';
export {
  OrchestratorPhase,
  ResearchMode,
  ResearchContext,
  Orchestrator,
} from './modes/research-mode/index.js';
export { convertToSSEEvent } from './modes/research-mode/index.js';
export type {
  ExtendedResearchSSEEvent,
  QueryComplexity,
  SearchQueryType,
  SearchStrategy,
  AnswerQuality,
  ResearchQuestion,
  ResearchFinding,
  FindingContradiction,
  ResearchEntity,
  ResearchStateSummary,
  OrchestratorConfig,
  OrchestratorDependencies,
  EvidenceChain,
  EvidenceNode,
  DiffAnalysis,
  DiffPoint,
  ExportResult,
  ShareLink,
  ContinueResearchResult,
  ResearchEvent,
} from './modes/research-mode/index.js';

export { duyaAgent, duyaAgent as default } from './agent/DuyaAgent.js';

