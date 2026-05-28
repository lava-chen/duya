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