// packages/agent/src/mcp/security.ts
// MCP security primitives — ported from hermes-agent's MCP hardening layer.
//
// MCP servers are untrusted external processes. This module centralizes the
// security primitives that sit between the agent and those processes:
//
//   1. Env allowlist      — strip secrets from the subprocess environment
//   2. Secret sanitization — redact credentials in tool error messages
//   3. Prompt injection scan — warn on suspicious tool descriptions
//   4. Sampling rate limit  — cap reverse LLM calls (sampling/createMessage)
//
// Design principle: this module is an OBSERVATION + SANITIZATION layer. It
// never blocks a legitimate MCP server. Blocking policy lives in
// permission-gate.ts (source-based) and the tool permission system
// (PermissionMode). Here we only filter what crosses the trust boundary.

import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// 1. Env allowlist
// ---------------------------------------------------------------------------

/**
 * Environment variables that are safe to pass to stdio MCP subprocesses.
 * These carry no secrets — they are process/location metadata needed by
 * shells, launchers, and locale-aware tools.
 */
export const SAFE_ENV_KEYS = new Set<string>([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'TMPDIR',
]);

/**
 * Windows-specific safe keys. Matched case-insensitively because Windows
 * env vars are case-insensitive (PATH == Path == path). These are needed
 * by launcher-style MCP tools (Docker Desktop plugin discovery, etc.) and
 * carry no secrets.
 */
export const SAFE_ENV_KEYS_CASE_INSENSITIVE = new Set<string>([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBEROF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

/**
 * Build a filtered environment dict for stdio MCP subprocesses.
 *
 * Only passes through safe baseline variables (PATH, HOME, etc.) and XDG_*
 * variables from the current process environment, plus any variables
 * explicitly specified by the user in the server config (`userEnv`).
 *
 * This prevents accidentally leaking secrets like API keys, tokens, or
 * credentials to MCP server subprocesses. `userEnv` always wins — the
 * user's explicit config is trusted over the inherited process env.
 *
 * @param userEnv Optional user-configured env vars from MCPServerConfig.env
 * @param options.forceInherit When true, return `{...process.env, ...userEnv}`
 *   without filtering (legacy mode for trusted bundled servers). Defaults to
 *   false.
 */
export function buildSafeEnv(
  userEnv?: Record<string, string>,
  options?: { forceInherit?: boolean },
): Record<string, string> {
  // Legacy / trusted-bundled path: pass everything through. Used only when
  // MCPServerConfig.envPassthrough === 'inherit' is explicitly set by a
  // trusted source (bundled servers that depend on inherited env).
  if (options?.forceInherit) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (userEnv) Object.assign(env, userEnv);
    return env;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      SAFE_ENV_KEYS.has(key) ||
      SAFE_ENV_KEYS_CASE_INSENSITIVE.has(key.toUpperCase()) ||
      key.startsWith('XDG_')
    ) {
      env[key] = value;
    }
  }
  // User-configured env always wins, even for keys that were filtered out.
  // The user explicitly typed these into the server config, so they are
  // trusted by definition.
  if (userEnv) {
    for (const [k, v] of Object.entries(userEnv)) {
      env[k] = v;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// 2. Secret sanitization
// ---------------------------------------------------------------------------

/**
 * Regex matching credential-like patterns that should be redacted before
 * a tool error message or result is returned to the LLM.
 *
 * Order matters: longer/more-specific patterns first. The `gi` flag makes
 * this global + case-insensitive (credentials are case-sensitive, but the
 * prefix tokens like `Bearer`, `API_KEY=` are conventionally upper or
 * mixed case).
 *
 * Note: the `sk-` pattern includes `-` in its character class (unlike the
 * hermes-agent original) so that modern OpenAI keys like `sk-proj-abc...`
 * are fully redacted rather than leaving a `-abc...` tail in the output.
 */
export const CREDENTIAL_PATTERN =
  /(?:ghp_[A-Za-z0-9_]{1,255}|sk-[A-Za-z0-9_-]{1,255}|Bearer\s+\S+|token=[^\s&,;"']{1,255}|key=[^\s&,;"']{1,255}|API_KEY=[^\s&,;"']{1,255}|password=[^\s&,;"']{1,255}|secret=[^\s&,;"']{1,255})/gi;

/**
 * Strip credential-like patterns from text before returning to the LLM.
 *
 * Replaces tokens, keys, and other secrets with `[REDACTED]` to prevent
 * accidental credential exposure in tool error responses. Non-destructive:
 * returns a new string. Used on MCP tool error messages before they become
 * ToolResult.result.
 *
 * @example
 *   sanitizeSecrets('Auth failed for token=abc123') // 'Auth failed for [REDACTED]'
 *   sanitizeSecrets('ghp_abcdef123456 is invalid')  // '[REDACTED] is invalid'
 */
export function sanitizeSecrets(text: string): string {
  if (!text) return text;
  return text.replace(CREDENTIAL_PATTERN, '[REDACTED]');
}

// ---------------------------------------------------------------------------
// 3. Prompt injection scan
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate potential prompt injection in MCP tool descriptions.
 *
 * These are WARNING-level — we log but don't block, since false positives
 * would break legitimate MCP servers (e.g. a security-tooling server whose
 * description legitimately mentions "ignore previous instructions" as a
 * test case). The scan exists to surface suspicious servers to the operator
 * via logs, not to enforce policy.
 *
 * Ported from hermes-agent `tools/mcp_tool.py:_MCP_INJECTION_PATTERNS`.
 */
export const MCP_INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /ignore\s+(all\s+)?previous\s+instructions/i,
    reason: "prompt override attempt ('ignore previous instructions')",
  },
  {
    pattern: /you\s+are\s+now\s+a/i,
    reason: "identity override attempt ('you are now a...')",
  },
  {
    pattern: /your\s+new\s+(task|role|instructions?)\s+(is|are)/i,
    reason: 'task override attempt',
  },
  {
    pattern: /system\s*:\s*/i,
    reason: 'system prompt injection attempt',
  },
  {
    pattern: /<\s*(system|human|assistant)\s*>/i,
    reason: 'role tag injection attempt',
  },
  {
    pattern: /do\s+not\s+(tell|inform|mention|reveal)/i,
    reason: 'concealment instruction',
  },
  {
    pattern: /(curl|wget|fetch)\s+https?:\/\//i,
    reason: 'network command in description',
  },
  {
    pattern: /base64\.(b64decode|decodebytes)/i,
    reason: 'base64 decode reference',
  },
  {
    pattern: /exec\s*\(|eval\s*\(/i,
    reason: 'code execution reference',
  },
  {
    pattern: /import\s+(subprocess|os|shutil|socket)/i,
    reason: 'dangerous import reference',
  },
];

/**
 * Scan an MCP tool description for prompt injection patterns.
 *
 * Returns a list of finding strings (empty = clean). Logs a WARN with the
 * server name, tool name, and findings when any pattern matches. Does NOT
 * throw or block — the caller may still register the tool; this is an
 * observation layer only.
 *
 * @returns Array of human-readable finding reasons. Empty array = clean.
 */
export function scanMcpDescription(
  serverName: string,
  toolName: string,
  description: string,
): string[] {
  if (!description) return [];
  const findings: string[] = [];
  for (const { pattern, reason } of MCP_INJECTION_PATTERNS) {
    if (pattern.test(description)) {
      findings.push(reason);
    }
  }
  if (findings.length > 0) {
    // Truncate description in the log to avoid spamming it with a long payload.
    const preview = description.slice(0, 200);
    logger.warn(
      `[MCP Security] server '${serverName}' tool '${toolName}': suspicious description — ${findings.join('; ')}. Preview: ${preview}`,
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 4. Sampling rate limiter
// ---------------------------------------------------------------------------

/**
 * Configuration for a per-server sampling rate limiter.
 *
 * MCP servers can request the client to sample an LLM on their behalf via
 * `sampling/createMessage`. Without limits a malicious or buggy server can
 * recursively drain the agent's token budget. These three knobs cap that
 * blast radius.
 */
export interface SamplingRateLimitConfig {
  /** Max sampling requests per minute (sliding window). Default 10. */
  maxRpm?: number;
  /** Hard cap on maxTokens per sampling request. Default 4096. */
  maxTokensCap?: number;
  /**
   * Max number of tool-use rounds within a single sampling request (server
   * asks for sampling → LLM returns tool_use → server calls tool → asks
   * again). 0 disables tool loops entirely. Default 5.
   */
  maxToolRounds?: number;
}

