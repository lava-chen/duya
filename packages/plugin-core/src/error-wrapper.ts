import { toPluginError, type PluginError } from './types';

export type PluginResult<T> =
  | { success: true; data: T }
  | { success: false; error: PluginError };

export async function withPluginError<T>(
  plugin: string,
  operation: string,
  fn: () => Promise<T>,
  errorMapper?: (err: unknown) => PluginError,
): Promise<PluginResult<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    const pluginErr = errorMapper
      ? errorMapper(err)
      : toPluginError(err, plugin);
    return { success: false, error: pluginErr };
  }
}

export function withPluginErrorSync<T>(
  plugin: string,
  operation: string,
  fn: () => T,
  errorMapper?: (err: unknown) => PluginError,
): PluginResult<T> {
  try {
    const data = fn();
    return { success: true, data };
  } catch (err) {
    const pluginErr = errorMapper
      ? errorMapper(err)
      : toPluginError(err, plugin);
    return { success: false, error: pluginErr };
  }
}

export function isSuccess<T>(result: PluginResult<T>): result is { success: true; data: T } {
  return result.success;
}

export function isFailure<T>(result: PluginResult<T>): result is { success: false; error: PluginError } {
  return !result.success;
}

export function unwrapResult<T>(result: PluginResult<T>): T {
  if (isSuccess(result)) {
    return result.data;
  }
  throw result.error;
}

export function unwrapOr<T>(result: PluginResult<T>, fallback: T): T {
  if (isSuccess(result)) {
    return result.data;
  }
  return fallback;
}

// ----------------------------------------------------------------------------
// MCP error wrapper (sibling of withPluginError).
//
// Plan 97 introduces typed MCP issues whose `error` field is an MCPError
// (MCPDiscoveryError | MCPConnectionError | MCPRegistrationError). This
// wrapper is a thin convenience around withPluginError for callers that
// want to surface MCP-typed errors uniformly. It does NOT replace the
// rich per-phase MCPIssue struct built in Phase 1; it is for code that
// just needs an MCPError-shaped result.
// ----------------------------------------------------------------------------

import type { MCPError } from './mcp/errors';

export type MCPResult<T> =
  | { success: true; data: T }
  | { success: false; error: MCPError };

export function isMCPError(err: unknown): err is MCPError {
  if (typeof err !== 'object' || err === null) return false;
  if (!('type' in err)) return false;
  const t = (err as Record<string, unknown>).type;
  return typeof t === 'string' && t.startsWith('mcp-');
}

export function toMCPError(err: unknown): MCPError {
  if (isMCPError(err)) return err;
  if (err instanceof Error) {
    return { type: 'mcp-protocol-error', serverName: '<unknown>', reason: err.message };
  }
  return { type: 'mcp-protocol-error', serverName: '<unknown>', reason: typeof err === 'string' ? err : String(err) };
}

export async function withMCPError<T>(
  operation: string,
  fn: () => Promise<T>,
  errorMapper?: (err: unknown) => MCPError,
): Promise<MCPResult<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    const mapped = errorMapper ? errorMapper(err) : toMCPError(err);
    // Tag the operation for log correlation; the MCPError shape is fixed.
    void operation;
    return { success: false, error: mapped };
  }
}