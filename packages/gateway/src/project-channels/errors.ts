/**
 * errors.ts — the only failure shape this transport throws.
 *
 * `verifyIdentity` / `inspectChannel` on `ProjectChannelTransportPort` are
 * declared as `Promise<T>` with no error union, so a failed verification has to
 * surface as a rejection. It rejects with this class, carrying one of A's
 * frozen `ProjectChannelErrorCode` values — never a raw provider error, never
 * the token, never the message text. The Host maps the code; it never parses
 * the message.
 */

import type { ProjectChannelErrorCode } from '@duya/agent-protocol/project-channels';
import { isProjectChannelRetryable } from '@duya/agent-protocol/project-channels';

export interface ProjectChannelTransportFailureParams {
  readonly code: ProjectChannelErrorCode;
  /** Structural diagnostic: endpoint and status only. Never a token or body. */
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  /** Platform HTTP status when one exists, for the Host's `cause` field. */
  readonly status?: number;
}

export class ProjectChannelTransportFailure extends Error {
  readonly code: ProjectChannelErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;

  constructor(params: ProjectChannelTransportFailureParams) {
    super(params.message);
    this.name = 'ProjectChannelTransportFailure';
    this.code = params.code;
    this.retryable = params.retryable ?? isProjectChannelRetryable(params.code);
    this.retryAfterMs = params.retryAfterMs;
    this.status = params.status;
  }
}

export function isProjectChannelTransportFailure(
  value: unknown,
): value is ProjectChannelTransportFailure {
  return value instanceof ProjectChannelTransportFailure;
}

/**
 * Strip anything that could be a credential before a diagnostic leaves this
 * module. A token can reach a log line through a provider error message, so
 * every assembled string passes through here.
 */
export function redactSecrets(
  message: string,
  secrets: readonly (string | undefined)[],
): string {
  let result = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    result = result.split(secret).join('[redacted]');
  }
  return result;
}
