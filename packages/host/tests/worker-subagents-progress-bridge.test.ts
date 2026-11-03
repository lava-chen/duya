import { describe, expect, it } from 'vitest';
import { buildChatAgentProgressPayload, type AgentProgressPayloadMeta } from '../src/worker-subagents/progress-bridge.js';
import type { AgentProgressEvent } from '../src/worker-subagents/types.js';

/**
 * The wire payload for a child's lifecycle.
 *
 * `parentToolCallId` is the ONLY field that ties a subagent back to the `task`
 * call sitting in the parent transcript: `agentId` is minted inside the bridge
 * and means nothing to the caller, and `agentSessionId` names the child's own
 * session. The protocol declares the field required, and it was never
 * populated — so every renderer saw an empty string and could not attach a
 * child to the row that started it. These two cases pin the fix.
 */

const META: AgentProgressPayloadMeta = {
  parentSessionId: 'parent-session',
  subAgentSessionId: 'child-session',
  agentId: 'agent-1',
  agentType: 'explorer',
  agentName: 'Robie',
  agentDescription: 'find the typecheck command',
};

const STARTED: AgentProgressEvent = { type: 'started' };

describe('buildChatAgentProgressPayload', () => {
  it('carries the spawning call id when the caller knows it', () => {
    const payload = buildChatAgentProgressPayload(STARTED, { ...META, parentToolCallId: 'call-7' });
    expect(payload.parentToolCallId).toBe('call-7');
    expect(payload).toMatchObject({
      type: 'chat:agent_progress',
      agentEventType: 'started',
      sessionId: 'parent-session',
      agentSessionId: 'child-session',
      agentType: 'explorer',
    });
  });

  it('omits the key rather than sending an empty id', () => {
    // Absent and empty must not look the same downstream: a completed frame is
    // resolved by the id learned at start, and `''` would be a parent call that
    // exists for nobody.
    expect(buildChatAgentProgressPayload(STARTED, META)).not.toHaveProperty('parentToolCallId');
  });

  it('passes an event-level agent id and duration through', () => {
    const payload = buildChatAgentProgressPayload(
      { type: 'done', agentId: 'agent-2', duration: 1_234 },
      { ...META, parentToolCallId: 'call-7' },
    );
    // The event's own id wins: it is the one the worker minted for that child.
    expect(payload.agentId).toBe('agent-2');
    expect(payload.duration).toBe(1_234);
  });
});
