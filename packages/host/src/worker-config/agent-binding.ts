/**
 * Whether the run's frozen selection asks for a different agent than the
 * one that is running.
 *
 * ## Why the model cannot be swapped per request
 *
 * The model is bound into the LLM client when the agent is BUILT, not when a
 * request is sent: the request body carries the model the client factory
 * captured, and the same construction decides the compaction budget, the
 * reasoning configuration and which tools the model can see. A turn that runs
 * under another model therefore needs another agent -- swapping the model id
 * on a request would answer with the new model but keep budgeting the
 * context window of the old one.
 *
 * ## What is compared
 *
 * The manifest records the selection the run was frozen with; the agent
 * records what it is bound to. Only fields both sides actually know are
 * compared:
 *
 * - the model, when the selection names one and the agent carries one;
 * - the provider, when the selection names one that is not the fallback
 *   `'env'` and the agent knows which provider it resolved to. The protocol
 *   discriminator cannot stand in for it: two providers can speak the same
 *   protocol, and switching provider changes the endpoint and the key.
 *
 * A side that cannot say (`''`) never decides the comparison. A selection
 * that names no model at all describes a run whose agent selection was left
 * to the environment, and that is not a disagreement.
 *
 * The shape is structural on purpose, like `worker-init-fingerprint.ts`: this
 * module reads the manifest's agent selection, not the manifest, so it can be
 * tested without minting one.
 */

/** The agent selection a run was frozen with. */
export interface AgentSelection {
  readonly model: string;
  readonly providerId: string;
}

/** What the running agent is bound to. */
export interface AgentBinding {
  /** The model the agent's LLM client was built with. */
  readonly model: string;
  /** The provider the agent resolved to; empty when it could not say. */
  readonly providerId: string;
}

/**
 * The manifest's fallback for "no provider was named". It is a sentinel, not
 * a provider id, and must never be compared against a resolved one.
 */
const UNNAMED_PROVIDER = 'env';

/**
 * Whether the selection asks for an agent other than the running one.
 */
export function manifestSelectsDifferentAgent(
  selection: AgentSelection | undefined,
  current: AgentBinding,
): boolean {
  if (selection === undefined) return false;
  const wantedModel = selection.model.trim();
  const wantedProvider = selection.providerId.trim();
  if (wantedModel === '' && wantedProvider === '') return false;
  if (wantedModel !== '' && wantedModel !== current.model) return true;
  if (
    wantedProvider !== ''
    && wantedProvider !== UNNAMED_PROVIDER
    && current.providerId !== ''
    && wantedProvider !== current.providerId
  ) {
    return true;
  }
  return false;
}
