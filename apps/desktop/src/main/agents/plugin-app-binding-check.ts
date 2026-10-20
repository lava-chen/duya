import type { CommandSenderFacts } from '@duya/host/command-receipt';

/** The three fields a worker may put in a `plugin-app:binding-current` request. */
const BINDING_CHECK_FIELDS = ['bindingId', 'nonce', 'toolId'] as const;

/** The caller facts the final side-effect fence is evaluated against. */
export interface PluginAppBindingCaller {
  readonly sessionId: string;
  readonly runId: string;
  readonly epoch: number;
}

/** The parsed payload of a `plugin-app:binding-current` request. */
export interface PluginAppBindingCheckPayload {
  readonly bindingId: string;
  readonly nonce: string;
  readonly toolId: string;
}

export interface PluginAppBindingCheckOptions {
  /** The request body. Owned by the worker, so it is only read, never trusted. */
  readonly payload: unknown;
  /** Who sent the request, as the transport knows it. */
  readonly sender?: CommandSenderFacts;
  /** The correlation the transport made, when it made one. */
  readonly trustedAttempt?: CommandSenderFacts['trustedAttempt'];
  /** The Host's own binding check, against the durable instance and grant ledger. */
  readonly isBindingCurrent: (
    bindingId: string,
    nonce: string,
    toolId: string,
    caller: PluginAppBindingCaller,
  ) => Promise<boolean>;
}

/**
 * Read a `plugin-app:binding-current` payload, or say why it is not one.
 *
 * No unknown fields: a payload carrying anything else is a payload the worker
 * invented for a reason nobody stated, and a fence that reads only the three
 * fields it knows would silently ignore the rest.
 */
export function parsePluginAppBindingCheckPayload(payload: unknown): PluginAppBindingCheckPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!BINDING_CHECK_FIELDS.includes(key as (typeof BINDING_CHECK_FIELDS)[number])) return null;
  }
  const { bindingId, nonce, toolId } = record;
  if (typeof bindingId !== 'string' || typeof nonce !== 'string' || typeof toolId !== 'string') return null;
  return { bindingId, nonce, toolId };
}

/**
 * The final side-effect fence of a Plugin App invocation.
 *
 * A worker asks "is this binding still current?" right before it causes the
 * side effect. The answer may only come from a correlation the TRANSPORT
 * made, because the worker owns the body it sends: a body that merely claims
 * an attempt is the worker's own claim about its identity, and a worker that
 * could state its own session, run and epoch could name another worker's
 * attempt.
 *
 * The caller facts handed to the Host are therefore the correlated ones, and
 * the body contributes nothing but the binding it names.
 */
export async function authorizePluginAppBindingCheck(options: PluginAppBindingCheckOptions): Promise<boolean> {
  const { payload, sender, trustedAttempt } = options;

  // A correlation has to exist. Without one there is nothing to check the
  // binding against, and a body that CLAIMS an attempt is a claim.
  if (!trustedAttempt) return false;

  // Only the Agent Server speaks this action. It is the transport that owns
  // the correlation, and it is not a session-registered worker: a worker
  // registered under a session is a different sender with a different
  // authority story, and this action is not that one.
  if (sender?.role !== 'agent-server' || sender.registeredSessionId !== null) return false;

  if (typeof trustedAttempt.sessionId !== 'string' || trustedAttempt.sessionId === '' ||
      typeof trustedAttempt.runId !== 'string' || trustedAttempt.runId === '' ||
      !Number.isSafeInteger(trustedAttempt.epoch)) return false;

  const parsed = parsePluginAppBindingCheckPayload(payload);
  if (!parsed) return false;

  return options.isBindingCurrent(parsed.bindingId, parsed.nonce, parsed.toolId, {
    sessionId: trustedAttempt.sessionId,
    runId: trustedAttempt.runId,
    epoch: trustedAttempt.epoch,
  });
}
