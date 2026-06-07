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
// Tool Filter Diagnostics
// ============================================================

export interface ToolFilterDiagnostics {
  /** Per-pattern, the list of tool names that pattern matched. */
  matchedPatterns: Array<{ pattern: string; matched: string[]; layer: 1 | 2 | 3 | 4 | 5 }>;
  /** Configured patterns that matched zero tools (e.g. an MCP tool family that isn't loaded). */
  unmatchedPatterns: string[];
  /** Tools that were kept because no rule denied them. */
  layerBreakdown: {
    layer1_allowlist: number;
    layer2_agentDenied: number;
    layer3_globalDenied: number;
    layer4_sandboxDenied: number;
    layer4_sandboxNotInAllowlist: number;
    layer5_subagentDenied: number;
    layer5_subagentNotInAllowlist: number;
  };
}

// ============================================================
// Filtering Logic
// ============================================================

export interface ToolFilterResult {
  allowed: string[];
  denied: string[];
  denialReasons: Map<string, string>;
  isValid: boolean;
  diagnostics: ToolFilterDiagnostics;
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

  const layerBreakdown = {
    layer1_allowlist: 0,
    layer2_agentDenied: 0,
    layer3_globalDenied: 0,
    layer4_sandboxDenied: 0,
    layer4_sandboxNotInAllowlist: 0,
    layer5_subagentDenied: 0,
    layer5_subagentNotInAllowlist: 0,
  };
  const matchedPatterns: Array<{ pattern: string; matched: string[]; layer: 1 | 2 | 3 | 4 | 5 }> = [];
  const allConfiguredPatterns = new Set<string>();

  // Layer 1: Agent allowedTools (whitelist)
  if (agentProfile.allowedTools && agentProfile.allowedTools.length > 0) {
    for (const pattern of agentProfile.allowedTools) allConfiguredPatterns.add(pattern)
    const expandedAllowed = expandToolGroups(agentProfile.allowedTools, allTools);
    for (const tool of allTools) {
      if (!expandedAllowed.includes(tool) && !denied.has(tool)) {
        allowed.delete(tool);
        denied.add(tool);
        denialReasons.set(tool, 'not_in_agent_allowlist');
        layerBreakdown.layer1_allowlist++;
      }
    }
    for (const pattern of agentProfile.allowedTools) {
      const matched = allTools.filter(t => matchToolPattern(t, pattern))
      if (matched.length > 0) {
        matchedPatterns.push({ pattern, matched, layer: 1 })
      }
    }
  }

  // Layer 2: Agent disallowedTools (blacklist)
  if (agentProfile.disallowedTools && agentProfile.disallowedTools.length > 0) {
    for (const pattern of agentProfile.disallowedTools) allConfiguredPatterns.add(pattern)
    for (const tool of allTools) {
      const matched = anyPatternMatches(tool, agentProfile.disallowedTools)
      if (matched && !denied.has(tool)) {
        allowed.delete(tool);
        denied.add(tool);
        denialReasons.set(tool, 'agent_denied');
        layerBreakdown.layer2_agentDenied++;
      }
    }
    for (const pattern of agentProfile.disallowedTools) {
      const matched = allTools.filter(t => matchToolPattern(t, pattern))
      if (matched.length > 0) {
        matchedPatterns.push({ pattern, matched, layer: 2 })
      }
    }
  }

  // Layer 3: Global deny list
  if (context.globalDisallowedTools && context.globalDisallowedTools.length > 0) {
    for (const pattern of context.globalDisallowedTools) allConfiguredPatterns.add(pattern)
    for (const tool of allTools) {
      if (anyPatternMatches(tool, context.globalDisallowedTools)) {
        const wasNew = !denied.has(tool)
        allowed.delete(tool);
        denied.add(tool);
        denialReasons.set(tool, 'globally_denied');
        if (wasNew) layerBreakdown.layer3_globalDenied++;
      }
    }
    for (const pattern of context.globalDisallowedTools) {
      const matched = allTools.filter(t => matchToolPattern(t, pattern))
      if (matched.length > 0) {
        matchedPatterns.push({ pattern, matched, layer: 3 })
      }
    }
  }

  // Layer 4: Sandbox policy
  if (context.sandboxPolicy) {
    if (context.sandboxPolicy.deny && context.sandboxPolicy.deny.length > 0) {
      for (const pattern of context.sandboxPolicy.deny) allConfiguredPatterns.add(pattern)
      for (const tool of allTools) {
        if (anyPatternMatches(tool, context.sandboxPolicy.deny!) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'sandbox_denied');
          layerBreakdown.layer4_sandboxDenied++;
        }
      }
      for (const pattern of context.sandboxPolicy.deny) {
        const matched = allTools.filter(t => matchToolPattern(t, pattern))
        if (matched.length > 0) {
          matchedPatterns.push({ pattern, matched, layer: 4 })
        }
      }
    }

    if (context.sandboxPolicy.allow && context.sandboxPolicy.allow.length > 0) {
      for (const pattern of context.sandboxPolicy.allow) allConfiguredPatterns.add(pattern)
      const expandedAllowed = expandToolGroups(context.sandboxPolicy.allow, allTools);
      for (const tool of allTools) {
        if (!expandedAllowed.includes(tool) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'not_in_sandbox_allowlist');
          layerBreakdown.layer4_sandboxNotInAllowlist++;
        }
      }
      for (const pattern of context.sandboxPolicy.allow) {
        const matched = allTools.filter(t => matchToolPattern(t, pattern))
        if (matched.length > 0) {
          matchedPatterns.push({ pattern, matched, layer: 4 })
        }
      }
    }
  }

  // Layer 5: Subagent policy
  if (context.subagentPolicy) {
    if (context.subagentPolicy.deny && context.subagentPolicy.deny.length > 0) {
      for (const pattern of context.subagentPolicy.deny) allConfiguredPatterns.add(pattern)
      for (const tool of allTools) {
        if (anyPatternMatches(tool, context.subagentPolicy.deny!) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'subagent_denied');
          layerBreakdown.layer5_subagentDenied++;
        }
      }
      for (const pattern of context.subagentPolicy.deny) {
        const matched = allTools.filter(t => matchToolPattern(t, pattern))
        if (matched.length > 0) {
          matchedPatterns.push({ pattern, matched, layer: 4 })
        }
      }
    }

    if (context.subagentPolicy.allow && context.subagentPolicy.allow.length > 0) {
      for (const pattern of context.subagentPolicy.allow) allConfiguredPatterns.add(pattern)
      const expandedAllowed = expandToolGroups(context.subagentPolicy.allow, allTools);
      for (const tool of allTools) {
        if (!expandedAllowed.includes(tool) && !denied.has(tool)) {
          allowed.delete(tool);
          denied.add(tool);
          denialReasons.set(tool, 'not_in_subagent_allowlist');
          layerBreakdown.layer5_subagentNotInAllowlist++;
        }
      }
      for (const pattern of context.subagentPolicy.allow) {
        const matched = allTools.filter(t => matchToolPattern(t, pattern))
        if (matched.length > 0) {
          matchedPatterns.push({ pattern, matched, layer: 4 })
        }
      }
    }
  }

  const allowedArray = Array.from(allowed);

  // Compute unmatched patterns: configured patterns that matched zero tools.
  const unmatchedPatterns: string[] = []
  for (const pattern of allConfiguredPatterns) {
    const isMatched = matchedPatterns.some(mp => mp.pattern === pattern)
    if (!isMatched) unmatchedPatterns.push(pattern)
  }

  return {
    allowed: allowedArray,
    denied: Array.from(denied),
    denialReasons,
    isValid: allowedArray.length > 0,
    diagnostics: {
      matchedPatterns,
      unmatchedPatterns,
      layerBreakdown,
    },
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
