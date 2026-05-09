/**
 * Agent Profile System - Public API
 *
 * Slim design: agent profiles focus on tool scope.
 * Prompt customization is handled via AGENTS.md and Output Styles.
 */

// =============================================================================
// Types
// =============================================================================

export type {
  AgentProfile,
  AgentProfileDbRow,
} from './types.js';

export {
  PRESET_AGENT_PROFILES,
} from './types.js';

// =============================================================================
// Service
// =============================================================================

export type { AgentProfileService } from './AgentProfileService.js';
export {
  InMemoryAgentProfileService,
  getAgentProfileService,
  resetAgentProfileService,
  setAgentProfileService,
  rowToAgentProfile,
  profileToRow,
} from './AgentProfileService.js';

// =============================================================================
// Tool Filter
// =============================================================================

export type { ToolFilterContext, ToolFilterResult } from './ToolFilter.js';
export {
  filterTools,
  resolveAllowedTools,
  validateToolAccess,
  matchToolPattern,
  expandToolGroups,
} from './ToolFilter.js';

// =============================================================================
// Identity Helpers
// =============================================================================

export {
  getEmojiForProfile,
  getColorForProfile,
  getIdentityLabel,
} from './identity.js';
