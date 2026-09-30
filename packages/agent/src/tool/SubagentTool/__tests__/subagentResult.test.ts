import { describe, it, expect } from 'vitest';
import {
  SUBAGENT_EFFORT_LEVELS,
  SUBAGENT_PERMISSION_MODES,
  SUBAGENT_RUN_STATUSES,
  buildSubagentResult,
  normalizeEffort,
  normalizePermissionMode,
  normalizeToolOverlay,
  serializeSubagentResult,
  subagentToolResultSchema,
} from '../subagentResult.js';

const base = {
  status: 'completed' as const,
  agentType: 'Explore',
  resolvedAgentType: 'Explore',
  sessionId: 's-1',
  agentId: 'a-1',
  taskId: 't-1',
  content: 'done',
  background: false,
};

describe('normalizePermissionMode', () => {
  it('accepts the three worker-level agent modes', () => {
    for (const mode of SUBAGENT_PERMISSION_MODES) {
      expect(normalizePermissionMode(mode)).toBe(mode);
    }
  });

  it('rejects unknown values instead of silently downgrading', () => {
    expect(normalizePermissionMode('yolo')).toBeUndefined();
    expect(normalizePermissionMode('bypass')).toBeUndefined();
    expect(normalizePermissionMode(undefined)).toBeUndefined();
    expect(normalizePermissionMode(42)).toBeUndefined();
  });
});

describe('normalizeEffort', () => {
  it('is case-insensitive over the real budget vocabulary', () => {
    expect(normalizeEffort('HIGH')).toBe('high');
    expect(normalizeEffort(' medium ')).toBe('medium');
    expect(normalizeEffort('off')).toBe('off');
    for (const level of SUBAGENT_EFFORT_LEVELS) {
      expect(normalizeEffort(level)).toBe(level);
    }
  });

  it('rejects unknown values', () => {
    expect(normalizeEffort('turbo')).toBeUndefined();
    expect(normalizeEffort('auto')).toBeUndefined();
    expect(normalizeEffort(null)).toBeUndefined();
  });
});

describe('normalizeToolOverlay', () => {
  it('keeps a well-formed allow/deny overlay', () => {
    expect(normalizeToolOverlay({ allow: ['Read'], deny: ['Bash', 'Write'] })).toEqual({
      allow: ['Read'],
      deny: ['Bash', 'Write'],
    });
  });

  it('returns undefined for an empty or malformed overlay', () => {
    expect(normalizeToolOverlay({})).toBeUndefined();
    expect(normalizeToolOverlay({ allow: [] })).toBeUndefined();
    expect(normalizeToolOverlay({ allow: 'Read' })).toBeUndefined();
    expect(normalizeToolOverlay({ allow: [''] })).toBeUndefined();
    expect(normalizeToolOverlay({ allow: ['Read'], bogus: 1 })).toBeUndefined();
    expect(normalizeToolOverlay(undefined)).toBeUndefined();
  });

  it('copies the arrays so a later mutation of the model input cannot leak', () => {
    const input = { allow: ['Read'] };
    const overlay = normalizeToolOverlay(input)!;
    input.allow.push('Bash');
    expect(overlay.allow).toEqual(['Read']);
  });
});

describe('buildSubagentResult', () => {
  it('fills the counters that the renderer expects to be present', () => {
    const receipt = buildSubagentResult(base);
    expect(receipt.totalToolUseCount).toBe(0);
    expect(receipt.totalDurationMs).toBe(0);
    expect(receipt.totalTokens).toBe(0);
  });

  it('omits absent optional fields rather than emitting null', () => {
    const receipt = buildSubagentResult(base);
    expect('outputFilePath' in receipt).toBe(false);
    expect('usage' in receipt).toBe(false);
    expect('isolation' in receipt).toBe(false);
    expect('warnings' in receipt).toBe(false);
    expect('error' in receipt).toBe(false);
  });

  it('rejects a receipt missing an identity field the renderer needs', () => {
    expect(() => buildSubagentResult({ ...base, sessionId: '' })).toThrow();
    expect(() => buildSubagentResult({ ...base, status: 'weird' as never })).toThrow();
  });

  it('rejects a receipt whose schema gained a misspelled field', () => {
    // `buildSubagentResult` is a builder: it copies a fixed set of fields, so
    // it cannot smuggle an extra key. The schema is what defends the wire
    // contract when a payload is parsed rather than constructed.
    expect(() =>
      subagentToolResultSchema.parse({ ...base, turns: 1 }),
    ).toThrow();
  });

  it('accepts every status in the shared vocabulary', () => {
    for (const status of SUBAGENT_RUN_STATUSES) {
      expect(buildSubagentResult({ ...base, status }).status).toBe(status);
    }
  });

  it('preserves isolation, warnings and usage when present', () => {
    const receipt = buildSubagentResult({
      ...base,
      isolation: 'worktree',
      workingDirectory: '/tmp/wt',
      warnings: ['resume substituted a fresh session'],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 8,
      },
    });
    expect(receipt.isolation).toBe('worktree');
    expect(receipt.workingDirectory).toBe('/tmp/wt');
    expect(receipt.warnings).toHaveLength(1);
    expect(receipt.usage?.cache_read_input_tokens).toBe(8);
  });
});

describe('serializeSubagentResult', () => {
  it('round-trips through JSON with the field names the renderer parser reads', () => {
    const parsed = JSON.parse(serializeSubagentResult({ ...base, background: true }));
    for (const key of [
      'status',
      'agentType',
      'resolvedAgentType',
      'content',
      'sessionId',
      'agentId',
      'taskId',
      'background',
    ]) {
      expect(parsed).toHaveProperty(key);
    }
  });
});
