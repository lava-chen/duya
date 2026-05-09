/**
 * ToolFilter - Multi-layer tool filtering engine
 * Filters tools based on agent profile, global, sandbox, and subagent policies.
 */

import type { AgentProfile } from './types.js';

// ============================================================
// Filter Context
// ============================================================

export interface ToolFilterContext {
  agentProfile: AgentProfile;
  globalDisallowedTools?: string[];
  sandboxPolicy?: {
    allow?: string[];
    deny?: string[];
  };
  subagentPolicy?: {
    allow?: string[];
    deny?: string[];
  };
  allTools: string[];
}

// ============================================================
// Wildcard Matching
// ============================================================

export function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;

  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(toolName);
  }

  return false;
}

function anyPatternMatches(toolName: string, patterns: string[]): boolean {
  return patterns.some(pattern => matchToolPattern(toolName, pattern));
}

// ============================================================
// Tool Group Expansion
// ============================================================

export function expandToolGroups(
  patterns: string[],
  allTools: string[]
): string[] {
  const result = new Set<string>();

  for (const pattern of patterns) {
    if (pattern === '*') {
      for (const tool of allTools) {
        result.add(tool);
      }
      continue;
    }

    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -1);
      for (const tool of allTools) {
        if (tool.startsWith(prefix)) {
          result.add(tool);
        }
      }
      continue;
    }

    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const tool of allTools) {
        if (regex.test(tool)) {
          result.add(tool);
        }
      }
      continue;
    }

    result.add(pattern);
  }

  return Array.from(result);
}

// ============================================================
// Filtering Logic
// ============================================================

export interface ToolFilterResult {
  allowed: string[];
  denied: string[];
  denialReasons: Map<string, string>;
  isValid: boolean;
}

/**
 * Apply multi-layer tool filtering.
 *
 * Filter order (later layers can only further restrict):
 * 1. Agent allowedTools (whitelist)
 * 2. Agent disallowedTools (blacklist)
 * 3. Global deny list
 * 4. Sandbox policy
 * 5. Subagent policy
 *
 * Rule: deny always takes precedence over allow.
 */
export function filterTools(context: ToolFilterContext): ToolFilterResult {
  const { agentProfile, allTools } = context;
  const allowed = new Set<string>();
  const denied = new Set<string>();
  const denialReasons = new Map<string, string>();

  for (const tool of allTools) {
    allowed.add(tool);
  }

  // Layer 1: Agent allowedTools (whitelist)
  if (agentProfile.allowedTools && agentProfile.allowedTools.length > 0) {
    const expandedAllowed = expandToolGroups(agentProfile.allowedTools, allTools);
    for (const tool of allTools) {
      if (!expandedAllowed.includes(tool) && !denied.has(tool)) {
        allowed.delete(tool);
        denied.add(tool);
        denialReasons.set(tool, 'not_in_agent_allowlist');
      }
    }
  }

  // Layer 2: Agent disallowedTools (blacklist)
  if (agentProfile.disallowedTools && agentProfile.disallowedTools.length > 0) {
    for (const tool of allTools) {
      if (anyPatternMatches(tool, agentProfile.disallowedTools) && !denied.has(tool)) {
        allowed.delete(tool);
        denied.add(tool);
        denialReasons.set(tool, 'agent_denied');
      }
    }
  }

  // Layer 3: Global deny list
  if (context.globalDisallowedTools && context.globalDisallowedTools.length > 0) {
    for (const tool of allTools) {
      if (anyPatternMatches(tool, context.globalDisallowedTools)) {
        allowed.delete(tool);
        denied.add(tool);
        denialReasons.set(tool, 'globally_denied');
      }
    }
  }

  // Layer 4: Sandbox policy
  if (context.sandboxPolicy) {
    if (context.sandboxPolicy.deny && context.sandboxPolicy.deny.length > 0) {
      for (const tool of allTools) {
        if (anyPatternMatches(tool, context.sandboxPolicy.deny) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'sandbox_denied');
        }
      }
    }

    if (context.sandboxPolicy.allow && context.sandboxPolicy.allow.length > 0) {
      const expandedAllowed = expandToolGroups(context.sandboxPolicy.allow, allTools);
      for (const tool of allTools) {
        if (!expandedAllowed.includes(tool) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'not_in_sandbox_allowlist');
        }
      }
    }
  }

  // Layer 5: Subagent policy
  if (context.subagentPolicy) {
    if (context.subagentPolicy.deny && context.subagentPolicy.deny.length > 0) {
      for (const tool of allTools) {
        if (anyPatternMatches(tool, context.subagentPolicy.deny) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'subagent_denied');
        }
      }
    }

    if (context.subagentPolicy.allow && context.subagentPolicy.allow.length > 0) {
      const expandedAllowed = expandToolGroups(context.subagentPolicy.allow, allTools);
      for (const tool of allTools) {
        if (!expandedAllowed.includes(tool) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'not_in_subagent_allowlist');
        }
      }
    }
  }

  const allowedArray = Array.from(allowed);

  return {
    allowed: allowedArray,
    denied: Array.from(denied),
    denialReasons,
    isValid: allowedArray.length > 0,
  };
}

/**
 * Resolve allowed tools for an agent profile.
 * Applies agent-level filtering plus global denials.
 */
export function resolveAllowedTools(
  agentProfile: AgentProfile,
  allTools: string[],
  globalDisallowedTools?: string[]
): ToolFilterResult {
  return filterTools({
    agentProfile,
    allTools,
    globalDisallowedTools,
  });
}

export function validateToolAccess(result: ToolFilterResult): void {
  if (!result.isValid) {
    const reasons = Array.from(result.denialReasons.entries())
      .map(([tool, reason]) => `  - ${tool}: ${reason}`)
      .join('\n');
    throw new Error(
      `No tools available after filtering. All ${result.denied.length} tools were denied:\n${reasons}`
    );
  }
}
