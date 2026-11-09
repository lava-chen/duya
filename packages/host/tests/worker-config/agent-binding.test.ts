import { describe, expect, it } from 'vitest';
import { manifestSelectsDifferentAgent } from '../../src/worker-config/agent-binding.js';

/**
 * The agent selection is the only part of the manifest this comparison
 * reads, so the fixtures carry it alone. A selection that names no agent
 * describes a run whose selection was left to the environment.
 */
describe('manifestSelectsDifferentAgent', () => {
  it('reports no difference when the selection names the running model', () => {
    expect(manifestSelectsDifferentAgent(
      { model: 'model-b', providerId: 'provider-1' },
      { model: 'model-b', providerId: 'provider-1' },
    )).toBe(false);
  });

  it('reports a difference when the run selected another model', () => {
    // The bug this pins: the model is bound into the LLM client when the
    // agent is BUILT, so a run that names another model has to run under
    // another agent. Comparing only the provider would let the old model
    // answer a turn the run recorded under the new one.
    expect(manifestSelectsDifferentAgent(
      { model: 'model-b', providerId: 'provider-1' },
      { model: 'model-a', providerId: 'provider-1' },
    )).toBe(true);
  });

  it('reports a difference when the run selected another provider', () => {
    // Two providers can speak the same protocol, so the provider is compared
    // by id: switching provider changes the endpoint and the key.
    expect(manifestSelectsDifferentAgent(
      { model: 'model-a', providerId: 'provider-2' },
      { model: 'model-a', providerId: 'provider-1' },
    )).toBe(true);
  });

  it('does not treat the unnamed-provider fallback as a provider', () => {
    // 'env' is what the manifest records when no provider was named. It is a
    // sentinel, and comparing it against a resolved provider would rebuild
    // the agent on every turn.
    expect(manifestSelectsDifferentAgent(
      { model: 'model-a', providerId: 'env' },
      { model: 'model-a', providerId: 'provider-1' },
    )).toBe(false);
  });

  it('does not decide the comparison from a side that cannot say', () => {
    expect(manifestSelectsDifferentAgent(
      { model: 'model-b', providerId: 'provider-1' },
      { model: '', providerId: '' },
    )).toBe(false);
    expect(manifestSelectsDifferentAgent(
      { model: '', providerId: '' },
      { model: 'model-a', providerId: 'provider-1' },
    )).toBe(false);
  });

  it('has nothing to compare when the run names no agent', () => {
    expect(manifestSelectsDifferentAgent(
      undefined,
      { model: 'model-a', providerId: 'provider-1' },
    )).toBe(false);
  });
});
