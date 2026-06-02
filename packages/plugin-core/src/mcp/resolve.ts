// packages/plugin-core/src/mcp/resolve.ts
// Pure resolution engine for MCP server candidates.
//
// `resolveMCPDiscovery(candidates, context)` consumes a pre-collected
// `MCPCandidate[]` and an explicit `ResolutionContext` and returns a
// `ResolutionResult` with three buckets: `inventory`,
// `resolvedConfigs`, and `issues`. The engine does NOT read the plugin
// registry, the settings DB, `process.env`, or any I/O. All data must
// be passed in.
//
// The engine performs ONLY static checks (per Rev 3 §G):
//   - shape validation of each candidate
//   - env expansion (using the explicit `environment` in context)
//   - script path existence on disk (via `fs.existsSync`)
//   - path-traversal guard for plugin-provided relative paths
//
// Dynamic checks (spawn, connect, timeout, transport errors) happen
// downstream in MCPClient / MCPManager and are reported as
// `MCPConnectionError` with `phase: 'connection'`. This engine does
// not produce them.

import { existsSync } from 'fs';
import { resolve as pathResolve, isAbsolute } from 'path';

import {
  expandMcpServerConfig,
} from './env-expansion';
import {
  type MCPCandidate,
  type ResolutionContext,
  type ResolutionResult,
  type MCPServerInventoryEntry,
  type ResolvedMCPServerConfig,
  type MCPSourceContext,
} from './discovery';
import type { MCPDiscoveryStatus } from './status';
import { buildInventoryId } from './scope';
import { applySourceShadowing } from './shadow';
import {
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
} from './error-messages';
import type { MCPIssue, MCPError } from './errors';

// ----------------------------------------------------------------------------
// Shape validation
// ----------------------------------------------------------------------------

interface ValidationResult {
  ok: boolean;
  reason?: string;
}

function validateRawConfig(raw: MCPCandidate['rawConfig']): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'rawConfig is not an object' };
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return { ok: false, reason: 'rawConfig.name must be a non-empty string' };
  }
  if (typeof raw.command !== 'string') {
    return { ok: false, reason: 'rawConfig.command must be a string' };
  }
  if (raw.args !== undefined && !Array.isArray(raw.args)) {
    return { ok: false, reason: 'rawConfig.args must be an array when present' };
  }
  for (const a of raw.args ?? []) {
    if (typeof a !== 'string') {
      return { ok: false, reason: 'every rawConfig.args entry must be a string' };
    }
  }
  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null) {
      return { ok: false, reason: 'rawConfig.env must be an object when present' };
    }
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== 'string') {
        return { ok: false, reason: `rawConfig.env.${k} must be a string` };
      }
    }
  }
  if (raw.allowedAgentIds !== undefined) {
    if (!Array.isArray(raw.allowedAgentIds)) {
      return { ok: false, reason: 'rawConfig.allowedAgentIds must be an array when present' };
    }
    for (const id of raw.allowedAgentIds) {
      if (typeof id !== 'string') {
        return { ok: false, reason: 'every rawConfig.allowedAgentIds entry must be a string' };
      }
    }
  }
  if (raw.overrideTarget !== undefined && typeof raw.overrideTarget !== 'string') {
    return { ok: false, reason: 'rawConfig.overrideTarget must be a string when present' };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Source context helpers
// ----------------------------------------------------------------------------

function buildSourceContext(c: MCPCandidate): MCPSourceContext {
  return {
    source: c.source,
    sourceSubOrigin: c.sourceSubOrigin,
    pluginId: c.pluginId,
    pluginName: c.pluginName,
  };
}

function buildScopedServerName(c: MCPCandidate): string {
  if (c.source === 'plugin' && c.pluginId) {
    return `plugin:${c.pluginId}:${c.rawConfig.name}`;
  }
  return c.rawConfig.name;
}

function expandCandidate(
  c: MCPCandidate,
  ctx: ResolutionContext,
): {
  expanded: { command: string; args: string[]; env: Record<string, string> };
  missingVars: string[];
  missingKeys: string[];
} {
  const userConfig = c.pluginId ? ctx.userConfigByPlugin[c.pluginId] : undefined;
  return expandMcpServerConfig(
    { command: c.rawConfig.command, args: c.rawConfig.args, env: c.rawConfig.env },
    {
      environment: ctx.environment,
      plugin:
        c.pluginRoot || c.pluginDataPath
          ? { root: c.pluginRoot, dataPath: c.pluginDataPath }
          : undefined,
      userConfig,
    },
  );
}

// ----------------------------------------------------------------------------
// Issue factories
// ----------------------------------------------------------------------------

function makeIssue(
  c: MCPCandidate,
  error: MCPError,
  phase: MCPIssue['phase'],
  inventoryId: string | undefined,
  serverNameOverride?: string,
): MCPIssue {
  return {
    phase,
    source: buildSourceContext(c),
    inventoryId,
    serverName: serverNameOverride ?? c.rawConfig.name,
    error,
    humanMessage: getMCPErrorMessage(error),
    severity: getMCPErrorSeverity(error),
    suggestedAction: getMCPSuggestedAction(error),
  };
}

function emptyCommandIssue(c: MCPCandidate, inventoryId?: string): MCPIssue {
  return makeIssue(
    c,
    { type: 'mcp-empty-command', source: buildSourceContext(c), serverName: c.rawConfig.name },
    'discovery',
    inventoryId,
  );
}

function commandMissingIssue(
  c: MCPCandidate,
  inventoryId: string | undefined,
  command: string,
): MCPIssue {
  return makeIssue(
    c,
    { type: 'mcp-command-missing', source: buildSourceContext(c), serverName: c.rawConfig.name, command },
    'discovery',
    inventoryId,
  );
}

function scriptNotFoundIssue(
  c: MCPCandidate,
  inventoryId: string | undefined,
  expectedPath: string,
): MCPIssue {
  return makeIssue(
    c,
    { type: 'mcp-script-not-found', source: buildSourceContext(c), serverName: c.rawConfig.name, expectedPath },
    'resolution',
    inventoryId,
  );
}

function bundledMissingIssue(
  c: MCPCandidate,
  inventoryId: string | undefined,
  bundlePath: string,
): MCPIssue {
  return makeIssue(
    c,
    { type: 'mcp-bundled-missing', source: buildSourceContext(c), bundlePath },
    'resolution',
    inventoryId,
  );
}

function allowedPathsViolationIssue(
  c: MCPCandidate,
  inventoryId: string | undefined,
  path: string,
): MCPIssue {
  return makeIssue(
    c,
    { type: 'mcp-allowed-paths-violation', source: buildSourceContext(c), serverName: c.rawConfig.name, path },
    'resolution',
    inventoryId,
  );
}

function envMissingIssue(
  c: MCPCandidate,
  inventoryId: string | undefined,
  missingVars: string[],
): MCPIssue {
  return makeIssue(
    c,
    { type: 'mcp-env-var-missing', source: buildSourceContext(c), serverName: c.rawConfig.name, missingVars },
    'resolution',
    inventoryId,
  );
}

function userConfigMissingIssue(
  c: MCPCandidate,
  inventoryId: string | undefined,
  missingKeys: string[],
): MCPIssue {
  return makeIssue(
    c,
    { type: 'mcp-user-config-missing', source: buildSourceContext(c), serverName: c.rawConfig.name, missingKeys },
    'resolution',
    inventoryId,
  );
}

function manifestInvalidIssue(
  c: MCPCandidate,
  reason: string,
): MCPIssue {
  // `serverName` is optional in MCPDiscoveryError; we set it to the
  // rawConfig.name when present so the UI has a usable label.
  const error = {
    type: 'mcp-manifest-invalid' as const,
    source: buildSourceContext(c),
    serverName: c.rawConfig.name,
    reason,
  };
  return {
    phase: 'discovery',
    source: buildSourceContext(c),
    inventoryId: undefined,
    serverName: c.rawConfig.name,
    error,
    humanMessage: getMCPErrorMessage(error),
    severity: getMCPErrorSeverity(error),
    suggestedAction: getMCPSuggestedAction(error),
  };
}

function overrideTargetIssue(c: MCPCandidate, declaredTarget: string): MCPIssue {
  const error = {
    type: 'mcp-override-target-not-supported' as const,
    source: buildSourceContext(c),
    serverName: c.rawConfig.name,
    declaredTarget,
  };
  return {
    phase: 'resolution',
    source: buildSourceContext(c),
    inventoryId: undefined,
    serverName: c.rawConfig.name,
    error,
    humanMessage: getMCPErrorMessage(error),
    severity: getMCPErrorSeverity(error),
    suggestedAction: getMCPSuggestedAction(error),
  };
}

function shadowedIssue(
  loser: MCPServerInventoryEntry,
  shadowedByInventoryId: string,
): MCPIssue {
  const error = {
    type: 'mcp-server-shadowed' as const,
    source: {
      source: loser.source,
      sourceSubOrigin: loser.sourceSubOrigin,
      pluginId: loser.pluginId,
      pluginName: loser.pluginName,
    },
    serverName: loser.serverName,
    shadowedByInventoryId,
  };
  return {
    phase: 'resolution',
    source: error.source,
    inventoryId: loser.inventoryId,
    serverName: loser.serverName,
    error,
    humanMessage: getMCPErrorMessage(error),
    severity: getMCPErrorSeverity(error),
    suggestedAction: getMCPSuggestedAction(error),
  };
}

// ----------------------------------------------------------------------------
// Static path check
// ----------------------------------------------------------------------------

interface PathCheckResult {
  status: MCPDiscoveryStatus;
  issue?: MCPIssue;
}

function isNodeLikeCommand(command: string): boolean {
  const c = command.toLowerCase();
  return c === 'node' || c.endsWith('/node') || c.endsWith('\\node') ||
    c.endsWith('node.exe') || c.endsWith('/node.exe') || c.endsWith('\\node.exe');
}

function staticPathCheck(
  c: MCPCandidate,
  expanded: { command: string; args: string[] },
  inventoryId: string,
): PathCheckResult {
  if (expanded.command.trim().length === 0) {
    return { status: 'command_missing', issue: emptyCommandIssue(c, inventoryId) };
  }

  // `node` command: check args[0] existence when resolvable.
  if (isNodeLikeCommand(expanded.command) && expanded.args.length > 0) {
    const scriptArg = expanded.args[0];
    if (scriptArg.startsWith('./') || scriptArg.startsWith('../') || isAbsolute(scriptArg)) {
      const resolved = c.pluginRoot
        ? pathResolve(c.pluginRoot, scriptArg)
        : isAbsolute(scriptArg)
        ? scriptArg
        : null;
      if (resolved) {
        // Path-traversal guard.
        if (c.pluginRoot) {
          const normalizedResolved = pathResolve(resolved);
          const normalizedRoot = pathResolve(c.pluginRoot);
          if (!normalizedResolved.startsWith(normalizedRoot)) {
            return {
              status: 'allowed_paths_violation',
              issue: allowedPathsViolationIssue(c, inventoryId, scriptArg),
            };
          }
        }
        if (!existsSync(resolved)) {
          // Bundled entries are special: when the literal bundled
          // script is missing, the issue type is `mcp-bundled-missing`
          // (not `mcp-script-not-found`). This is a stable Phase 1B
          // contract: bundled absence is a build/installation problem
          // and should be displayed distinctly from per-plugin
          // script-missing errors.
          if (c.source === 'bundled') {
            return {
              status: 'script_missing',
              issue: bundledMissingIssue(c, inventoryId, resolved),
            };
          }
          return {
            status: 'script_missing',
            issue: scriptNotFoundIssue(c, inventoryId, resolved),
          };
        }
      }
    }
  }

  // `./` or `../` command with pluginRoot.
  if (
    c.pluginRoot &&
    (expanded.command.startsWith('./') || expanded.command.startsWith('../'))
  ) {
    const resolved = pathResolve(c.pluginRoot, expanded.command);
    if (!existsSync(resolved)) {
      return {
        status: 'command_missing',
        issue: commandMissingIssue(c, inventoryId, expanded.command),
      };
    }
  }

  return { status: 'configured' };
}

// ----------------------------------------------------------------------------
// Inventory + resolvedConfigs
// ----------------------------------------------------------------------------

interface ProcessedCandidate {
  inventory: MCPServerInventoryEntry;
  expanded: { command: string; args: string[]; env: Record<string, string> };
  /** Set only when staticPathCheck reported an issue. */
  pathIssue?: MCPIssue;
}

function processCandidate(
  c: MCPCandidate,
  ctx: ResolutionContext,
): ProcessedCandidate {
  const inventoryId = buildInventoryId({
    source: c.source,
    sourceSubOrigin: c.sourceSubOrigin,
    pluginId: c.pluginId,
    serverName: c.rawConfig.name,
  });

  const expansion = expandCandidate(c, ctx);

  // Status priority (highest to lowest):
  //   1. env_missing / user_config_missing: any reference to a variable
  //      or user_config key that did not resolve. These are configuration
  //      problems the user can fix in settings; the runtime will not be
  //      able to start the server cleanly.
  //   2. empty_command / command_missing / script_missing / allowed_paths_violation:
  //      static path failures. We run the path check only if env/user_config
  //      expansion was clean for the fields it covers; otherwise the
  //      missing-var issue is the more actionable diagnostic.
  //   3. configured.
  let status: MCPDiscoveryStatus;
  let pathIssue: MCPIssue | undefined;
  if (expansion.missingVars.length > 0) {
    status = 'env_missing';
  } else if (expansion.missingKeys.length > 0) {
    status = 'user_config_missing';
  } else {
    const pathCheck = staticPathCheck(c, expansion.expanded, inventoryId);
    status = pathCheck.status;
    pathIssue = pathCheck.issue;
  }

  const entry: MCPServerInventoryEntry = {
    inventoryId,
    source: c.source,
    sourceSubOrigin: c.sourceSubOrigin,
    pluginId: c.pluginId,
    pluginName: c.pluginName,
    serverName: c.rawConfig.name,
    scopedServerName: buildScopedServerName(c),
    rawConfig: {
      command: c.rawConfig.command,
      args: c.rawConfig.args,
      env: c.rawConfig.env,
      allowedAgentIds: c.rawConfig.allowedAgentIds,
    },
    discoveryStatus: status,
    allowedAgentIds: c.rawConfig.allowedAgentIds,
  };

  return { inventory: entry, expanded: expansion.expanded, pathIssue };
}

// ----------------------------------------------------------------------------
// The engine
// ----------------------------------------------------------------------------

export async function resolveMCPDiscovery(
  candidates: ReadonlyArray<MCPCandidate>,
  context: ResolutionContext,
): Promise<ResolutionResult> {
  const processed: Array<{ proc: ProcessedCandidate; issues: MCPIssue[]; candidate: MCPCandidate }> = [];

  for (const c of candidates) {
    const v = validateRawConfig(c.rawConfig);
    if (!v.ok) {
      processed.push({
        proc: {
          inventory: {
            inventoryId: buildInventoryId({
              source: c.source,
              sourceSubOrigin: c.sourceSubOrigin,
              pluginId: c.pluginId,
              serverName: c.rawConfig.name ?? '<invalid>',
            }),
            source: c.source,
            sourceSubOrigin: c.sourceSubOrigin,
            pluginId: c.pluginId,
            pluginName: c.pluginName,
            serverName: c.rawConfig.name ?? '<invalid>',
            scopedServerName: buildScopedServerName(c),
            rawConfig: { command: '', args: [], env: {} },
            discoveryStatus: 'manifest_invalid',
          },
          expanded: { command: '', args: [], env: {} },
        },
        issues: [manifestInvalidIssue(c, v.reason ?? 'unknown')],
        candidate: c,
      });
      continue;
    }

    const proc = processCandidate(c, context);
    const issues: MCPIssue[] = [];

    if (proc.inventory.discoveryStatus === 'env_missing') {
      // Re-derive missingVars to attach the issue.
      const expansion = expandCandidate(c, context);
      if (expansion.missingVars.length > 0) {
        issues.push(envMissingIssue(c, proc.inventory.inventoryId, expansion.missingVars));
      }
    }
    if (proc.inventory.discoveryStatus === 'user_config_missing') {
      const expansion = expandCandidate(c, context);
      if (expansion.missingKeys.length > 0) {
        issues.push(userConfigMissingIssue(c, proc.inventory.inventoryId, expansion.missingKeys));
      }
    }
    if (proc.pathIssue) {
      // The path check produced an issue; surface it. This covers
      // script_missing / command_missing / allowed_paths_violation.
      issues.push(proc.pathIssue);
    }

    if (c.rawConfig.overrideTarget) {
      issues.push(overrideTargetIssue(c, c.rawConfig.overrideTarget));
    }

    processed.push({ proc, issues, candidate: c });
  }

  // Apply shadow rules.
  const inventoryOnly = processed.map((p) => p.proc.inventory);
  const { inventory: shadowedInventory, shadowedEntries } = applySourceShadowing(inventoryOnly);

  const issues: MCPIssue[] = [];
  for (const p of processed) issues.push(...p.issues);
  for (const { loser, shadowedByInventoryId } of shadowedEntries) {
    issues.push(shadowedIssue(loser, shadowedByInventoryId));
  }

  // Build `resolvedConfigs` from non-shadowed, configured entries.
  const shadowedSet = new Set(
    shadowedEntries.map((s) => s.loser.inventoryId),
  );
  const resolvedConfigs: ResolvedMCPServerConfig[] = [];
  for (const p of processed) {
    const entry = shadowedInventory.find((e) => e.inventoryId === p.proc.inventory.inventoryId);
    if (!entry) continue;
    if (shadowedSet.has(entry.inventoryId)) continue;
    if (entry.discoveryStatus !== 'configured') continue;
    resolvedConfigs.push({
      inventoryId: entry.inventoryId,
      source: entry.source,
      sourceSubOrigin: entry.sourceSubOrigin,
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      scopedServerName: entry.scopedServerName,
      rawConfig: p.proc.expanded,
      allowedAgentIds: entry.allowedAgentIds,
    });
  }

  return { inventory: shadowedInventory, resolvedConfigs, issues };
}
