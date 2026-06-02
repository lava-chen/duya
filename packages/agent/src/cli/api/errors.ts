/**
 * packages/agent/src/cli/api/errors.ts
 *
 * CLI API client error taxonomy. Each error carries a user-facing hint that
 * the CLI prints verbatim (no token contents, no internal details).
 */

export type CliApiErrorKind =
  | 'app_not_running'
  | 'connection_refused'
  | 'timeout'
  | 'auth_failed'
  | 'not_found'
  | 'server_error'
  | 'malformed_response';

export class CliApiError extends Error {
  constructor(
    public readonly kind: CliApiErrorKind,
    message: string,
    public readonly hint: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'CliApiError';
  }

  /** True if this error means the desktop app is unavailable (the user
   *  should open DUYA and retry). */
  isAppUnavailable(): boolean {
    return this.kind === 'app_not_running' || this.kind === 'connection_refused';
  }
}

export const APP_NOT_RUNNING_HINT =
  'DUYA is not running. Open the DUYA app and retry.';

export const AUTH_FAILED_HINT =
  'Authentication failed. The DUYA app may have restarted; retry, or restart the DUYA app.';

