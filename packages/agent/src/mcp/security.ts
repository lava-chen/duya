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

const DEFAULT_MAX_RPM = 10;
const DEFAULT_MAX_TOKENS_CAP = 4096;
const DEFAULT_MAX_TOOL_ROUNDS = 5;
const RATE_WINDOW_MS = 60_000;

/**
 * Per-MCP-server sampling rate limiter.
 *
 * Each MCPClient that enables sampling creates one SamplingRateLimiter. All
 * state (rate-limit timestamps, tool-loop counter) lives on the instance —
 * no module-level globals, so concurrent servers don't interfere.
 *
 * Three knobs:
 *   - `checkRateLimit()` — sliding-window RPM check. Returns false if the
 *     server has already hit `maxRpm` in the last 60s.
 *   - `capMaxTokens(requested)` — clamp a requested maxTokens down to
 *     `maxTokensCap`. Never raises it.
 *   - `incrementToolRound()` — bump the per-sampling tool-loop counter.
 *     Returns false once `maxToolRounds` is exceeded (caller should refuse
 *     the further tool call).
 *
 * `resetToolRounds()` should be called at the start of each new
 * `sampling/createMessage` request so the counter tracks a single
 * conversation, not the server's lifetime.
 */
export class SamplingRateLimiter {
  readonly maxRpm: number;
  readonly maxTokensCap: number;
  readonly maxToolRounds: number;
  private rateTimestamps: number[] = [];
  private toolLoopCount = 0;

  constructor(config: SamplingRateLimitConfig = {}) {
    this.maxRpm = parsePositiveInt(config.maxRpm, DEFAULT_MAX_RPM);
    this.maxTokensCap = parsePositiveInt(config.maxTokensCap, DEFAULT_MAX_TOKENS_CAP);
    // maxToolRounds: 0 is a legal value (disable tool loops), so we can't
    // use the "falsy → default" shortcut; we must check undefined explicitly.
    this.maxToolRounds =
      config.maxToolRounds === undefined
        ? DEFAULT_MAX_TOOL_ROUNDS
        : parseNonNegativeInt(config.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS);
  }

  /**
   * Sliding-window rate limiter. Returns true if a new request is allowed,
   * false if the server has exceeded `maxRpm` in the last 60 seconds.
   *
   * Side effect: when allowed, records the current timestamp.
   */
  checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    // Drop timestamps older than the window. In-place filter keeps memory
    // bounded under sustained load.
    this.rateTimestamps = this.rateTimestamps.filter((t) => t > windowStart);
    if (this.rateTimestamps.length >= this.maxRpm) {
      return false;
    }
    this.rateTimestamps.push(now);
    return true;
  }

  /**
   * Clamp a requested maxTokens value down to `maxTokensCap`. Never raises
   * the value — if the server asks for less than the cap, we honor the
   * smaller value.
   */
  capMaxTokens(requested: number): number {
    if (!Number.isFinite(requested) || requested <= 0) {
      return this.maxTokensCap;
    }
    return Math.min(Math.floor(requested), this.maxTokensCap);
  }

  /**
   * Reset the per-sampling tool-loop counter. Call at the start of each
   * new `sampling/createMessage` request.
   */
  resetToolRounds(): void {
    this.toolLoopCount = 0;
  }

  /**
   * Bump the tool-loop counter. Returns true if the new round is allowed,
   * false if `maxToolRounds` has been exceeded (caller should refuse the
   * further tool call and surface an error to the server).
   *
   * When `maxToolRounds === 0`, tool loops are disabled entirely — the
   * first call returns false.
   */
  incrementToolRound(): boolean {
    this.toolLoopCount += 1;
    if (this.maxToolRounds === 0) return false;
    return this.toolLoopCount <= this.maxToolRounds;
  }

  /** Current tool-loop count (for observability / logging). */
  get toolRoundCount(): number {
    return this.toolLoopCount;
  }
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}
