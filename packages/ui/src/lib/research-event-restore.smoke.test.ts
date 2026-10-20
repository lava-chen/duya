import { beforeEach, describe, expect, it, vi } from 'vitest';

const GLOBAL_KEY = '__stream_session_manager__';

function resetManager() {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  delete global[GLOBAL_KEY];
}

describe('Deep Research durable event restore smoke', () => {
  beforeEach(() => {
    resetManager();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('rebuilds progress from persisted research_events and keeps artifacts', async () => {
    const now = Date.now();
    const persistedEvents = [
      {
        id: 'event-3',
        sequence: 3,
        event_type: 'research_iteration',
        visibility: 'user',
        created_at: now + 3,
        payload_json: JSON.stringify({
          type: 'research_iteration',
          data: {
            iteration: 1,
            maxIterations: 3,
            phase: 'start',
            questions: ['What matters?'],
            findingsCount: 0,
            coverage: 0,
            timestamp: now + 3,
          },
        }),
      },
      {
        id: 'event-1',
        sequence: 1,
        event_type: 'research_progress',
        visibility: 'user',
        created_at: now + 1,
        payload_json: JSON.stringify({
          type: 'research_progress',
          data: {
            phase: 'planning',
            iteration: 0,
            maxIterations: 3,
            coverage: 0,
            findingsCount: 0,
            questionCount: 0,
            timestamp: now + 1,
          },
        }),
      },
      {
        id: 'event-2',
        sequence: 2,
        event_type: 'research_questions',
        visibility: 'user',
        created_at: now + 2,
        payload_json: JSON.stringify({
          type: 'research_questions',
          data: {
            kind: 'plan_approval',
            questions: [{ id: 'q1', text: 'What matters?', type: 'text', required: false }],
            allowSkip: false,
            timestamp: now + 2,
            requestId: 'plan-1',
            maxIterations: 3,
            approvalRequired: true,
            plan: { researchQuestions: [{ id: 'q1', text: 'What matters?' }] },
          },
        }),
      },
      {
        id: 'event-4',
        sequence: 4,
        event_type: 'research_finding',
        visibility: 'user',
        created_at: now + 4,
        payload_json: JSON.stringify({
          type: 'research_finding',
          data: {
            finding: {
              id: 'f1',
              type: 'web',
              claim: 'A supported claim',
              content: 'Evidence text',
              source: 'Example Source',
              sourceReliability: 'high',
              authorityLevel: 'high',
              stance: 'supports',
              confidence: 0.9,
              title: 'Example Source',
              url: 'https://example.com/source',
              iteration: 1,
              relatedQuestionIds: ['q1'],
              limitations: [],
            },
            timestamp: now + 4,
          },
        }),
      },
    ];

    vi.doMock('./agent-http-client', () => ({
      getAgentServerClient: () => ({
        getResearchSnapshot: async () => ({
          id: 'run-1',
          session_id: 'session-1',
          original_query: 'Research something',
          status: 'active',
          run_status: 'running',
          current_phase: 'research_loop',
          context_json: JSON.stringify({
            findings: [{ id: 'legacy-finding', content: 'must not be truth source' }],
          }),
          iterations: 0,
          coverage: 0,
          created_at: now,
          updated_at: now,
          completed_at: null,
          workerActive: true,
          events: persistedEvents,
          sources: [{ id: 'src-1', title: 'Example Source', url: 'https://example.com/source' }],
          citations: [{ id: 'cite-1', source_id: 'src-1', claim: 'A supported claim' }],
          report: {
            id: 'report-1',
            markdown: '# Durable Report',
            source_ids_json: '["src-1"]',
            citation_ids_json: '["cite-1"]',
          },
        }),
      }),
    }));

    const { restoreResearchStateFromDB, streamSessionManager } = await import('./stream-session-manager');

    await expect(restoreResearchStateFromDB('session-1')).resolves.toBe(true);
    const restored = streamSessionManager.getResearchSnapshot('session-1');

    expect(restored?.runId).toBe('run-1');
    expect(restored?.currentIteration).toBe(1);
    expect(restored?.maxIterations).toBe(3);
    expect(restored?.planQuestions).toHaveLength(1);
    expect(restored?.findings).toHaveLength(1);
    expect(restored?.findings[0].id).toBe('f1');
    expect(restored?.reportText).toBe('# Durable Report');
    expect(restored?.persistedEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(restored?.persistedSources).toHaveLength(1);
    expect(restored?.persistedCitations).toHaveLength(1);
    expect(restored?.reportArtifact?.id).toBe('report-1');
  });

  it('restores awaiting plan approval as actionable when worker is still active', async () => {
    const now = Date.now();
    const persistedEvents = [
      {
        id: 'event-plan',
        sequence: 1,
        event_type: 'research_questions',
        visibility: 'user',
        created_at: now,
        payload_json: JSON.stringify({
          type: 'research_questions',
          data: {
            kind: 'plan_approval',
            questions: [{ id: 'q1', text: 'What should be researched?', type: 'text', required: false }],
            allowSkip: false,
            timestamp: now,
            requestId: 'plan-live',
            maxIterations: 3,
            approvalRequired: true,
            plan: { researchQuestions: [{ id: 'q1', text: 'What should be researched?' }] },
          },
        }),
      },
    ];

    vi.doMock('./agent-http-client', () => ({
      getAgentServerClient: () => ({
        getResearchSnapshot: async () => ({
          id: 'run-live',
          session_id: 'session-live',
          original_query: 'Live approval',
          status: 'active',
          run_status: 'awaiting_approval',
          current_phase: 'planning',
          context_json: '{}',
          iterations: 0,
          coverage: 0,
          created_at: now,
          updated_at: now,
          completed_at: null,
          workerActive: true,
          events: persistedEvents,
          sources: [],
          citations: [],
          report: null,
        }),
      }),
    }));

    const { restoreResearchStateFromDB, streamSessionManager } = await import('./stream-session-manager');

    await expect(restoreResearchStateFromDB('session-live')).resolves.toBe(true);
    const restored = streamSessionManager.getResearchSnapshot('session-live');

    expect(restored?.stage).toBe('awaiting_plan_approval');
    expect(restored?.active).toBe(true);
    expect(restored?.pendingRequest?.requestId).toBe('plan-live');
  });

  it('restores awaiting plan approval as visible but non-actionable when worker is gone', async () => {
    const now = Date.now();
    const persistedEvents = [
      {
        id: 'event-plan',
        sequence: 1,
        event_type: 'research_questions',
        visibility: 'user',
        created_at: now,
        payload_json: JSON.stringify({
          type: 'research_questions',
          data: {
            kind: 'plan_approval',
            questions: [{ id: 'q1', text: 'What should be researched?', type: 'text', required: false }],
            allowSkip: false,
            timestamp: now,
            requestId: 'plan-stale',
            maxIterations: 3,
            approvalRequired: true,
            plan: { researchQuestions: [{ id: 'q1', text: 'What should be researched?' }] },
          },
        }),
      },
    ];

    vi.doMock('./agent-http-client', () => ({
      getAgentServerClient: () => ({
        getResearchSnapshot: async () => ({
          id: 'run-stale',
          session_id: 'session-stale',
          original_query: 'Stale approval',
          status: 'active',
          run_status: 'awaiting_approval',
          current_phase: 'planning',
          context_json: '{}',
          iterations: 0,
          coverage: 0,
          created_at: now,
          updated_at: now,
          completed_at: null,
          workerActive: false,
          events: persistedEvents,
          sources: [],
          citations: [],
          report: null,
        }),
      }),
    }));

    const { restoreResearchStateFromDB, streamSessionManager } = await import('./stream-session-manager');

    await expect(restoreResearchStateFromDB('session-stale')).resolves.toBe(true);
    const restored = streamSessionManager.getResearchSnapshot('session-stale');

    expect(restored?.stage).toBe('awaiting_plan_approval');
    expect(restored?.active).toBe(false);
    expect(restored?.pendingRequest?.requestId).toBe('restored_plan_run-stale');
    expect(restored?.progressSummary).toContain('original worker is no longer running');
  });

  it('restores failed run as failed state instead of running or completed', async () => {
    const now = Date.now();

    vi.doMock('./agent-http-client', () => ({
      getAgentServerClient: () => ({
        getResearchSnapshot: async () => ({
          id: 'run-failed',
          session_id: 'session-failed',
          original_query: 'Research failure case',
          status: 'active',
          run_status: 'failed',
          current_phase: 'aborted',
          context_json: '{}',
          iterations: 2,
          coverage: 0.5,
          created_at: now - 1000,
          updated_at: now,
          completed_at: now,
          error_json: JSON.stringify({ message: 'persistence failed' }),
          events: [],
          sources: [],
          citations: [],
          report: null,
        }),
      }),
    }));

    const { restoreResearchStateFromDB, streamSessionManager } = await import('./stream-session-manager');

    await expect(restoreResearchStateFromDB('session-failed')).resolves.toBe(true);
    const restored = streamSessionManager.getResearchSnapshot('session-failed');

    expect(restored?.runStatus).toBe('failed');
    expect(restored?.stage).toBe('error');
    expect(restored?.active).toBe(false);
    expect(restored?.completedAt).toBe(now);
    expect(restored?.error).toBe('persistence failed');
  });
});
