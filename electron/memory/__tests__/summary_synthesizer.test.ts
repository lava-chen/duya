/**
 * Unit tests for Phase 3 semantic summary synthesizer.
 *
 * Uses real modules (only the LLM client is mocked). Verifies:
 *   - computeCanonicalHash determinism + sensitivity to content change
 *   - successful synthesis keeps the deterministic index and prepends
 *     the semantic block
 *   - tolerant JSON parsing (code fence / leading prose)
 *   - safe failure paths (junk response, empty response) → success:false
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AIClient } from '@duya/ai';

import {
  computeCanonicalHash,
  synthesizeSummary,
} from '../summary_synthesizer';

function createFixture() {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-root-'));
  const areasDir = path.join(memoryRoot, 'global', 'areas');
  const prefsDir = path.join(memoryRoot, 'global', 'preferences');
  fs.mkdirSync(areasDir, { recursive: true });
  fs.mkdirSync(prefsDir, { recursive: true });

  fs.writeFileSync(
    path.join(areasDir, 'canvas-tooling.md'),
    [
      '# Canvas Tooling',
      '## Summary',
      'Canvas MCP fallback protocol for DUYA sessions.',
      '## Details',
      '- When canvas is locked, use fallback paths.',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(prefsDir, 'communication.md'),
    [
      '# Communication',
      '## Summary',
      'User prefers concise Chinese replies.',
      '## Details',
      '- When replying, keep it short.',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(memoryRoot, 'MEMORY.md'),
    '# Durable Memory\n\n## area\n\n- **area:canvas-tooling**: ... → global/areas/canvas-tooling.md\n',
    'utf8',
  );

  const cleanup = () => {
    try { fs.rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  return { memoryRoot, cleanup };
}

function mockLlm(reply: string): AIClient {
  return {
    chat: vi.fn().mockResolvedValue({ content: reply, usage: { input_tokens: 1, output_tokens: 1 } }),
    streamChat: vi.fn(),
  } as unknown as AIClient;
}

/**
 * Capture the user prompt passed to the LLM (for input-assembly
 * assertions). Returns a chat mock whose `__lastUserPrompt()` accessor
 * returns the last `{ role: 'user' }` content string.
 */
function mockLlmWithCapture(reply: string): AIClient & { __lastUserPrompt: () => string } {
  let last = '';
  const client = mockLlm(reply);
  const chat = client.chat as ReturnType<typeof vi.fn>;
  chat.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
    last = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    return { content: reply, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  return Object.assign(client, { __lastUserPrompt: () => last });
}

const VALID_JSON = JSON.stringify({
  profile: 'User works on the DUYA desktop agent. Prefers concise Chinese replies.',
  top_rules: [
    { rule: 'When a canvas tool is locked, use the documented fallback protocol.', source: 'global/areas/canvas-tooling.md', priority: 1 },
  ],
  memory_map: [
    { topic: 'canvas tooling', keywords: ['canvas', 'fallback'], files: ['global/areas/canvas-tooling.md'] },
  ],
  gaps: ['User identity not registered.'],
});

describe('computeCanonicalHash', () => {
  let fx: ReturnType<typeof createFixture>;

  beforeEach(() => { fx = createFixture(); });
  afterEach(() => { fx.cleanup(); });

  it('is deterministic for unchanged content', async () => {
    const a = await computeCanonicalHash(fx.memoryRoot);
    const b = await computeCanonicalHash(fx.memoryRoot);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a canonical file changes', async () => {
    const before = await computeCanonicalHash(fx.memoryRoot);
    fs.appendFileSync(path.join(fx.memoryRoot, 'global', 'areas', 'canvas-tooling.md'), '\n- new fact\n');
    const after = await computeCanonicalHash(fx.memoryRoot);
    expect(after).not.toBe(before);
  });
});

describe('synthesizeSummary', () => {
  let fx: ReturnType<typeof createFixture>;

  beforeEach(() => { fx = createFixture(); });
  afterEach(() => { fx.cleanup(); });

  it('prepends the semantic block and keeps the deterministic index', async () => {
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm(VALID_JSON),
    });
    expect(res.success).toBe(true);
    expect(res.content).toBeTruthy();
    const c = res.content;
    expect(c).toContain('## Who is this user');
    expect(c).toContain('## Rules that matter');
    expect(c).toContain('## How to find things');
    expect(c).toContain('## Blind spots');
    // deterministic index preserved below the semantic block
    expect(c).toContain('## Essentials');
    expect(c).toContain('canvas-tooling');
  });

  it('parses JSON wrapped in a code fence', async () => {
    const wrapped = '```json\n' + VALID_JSON + '\n```';
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm(wrapped),
    });
    expect(res.success).toBe(true);
  });

  it('parses JSON with a leading prose preamble', async () => {
    const preamble = 'Here is the digest:\n' + VALID_JSON;
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm(preamble),
    });
    expect(res.success).toBe(true);
  });

  it('salvages the digest when a keywords array exceeds the schema cap', async () => {
    // 2026-08-17 regression: LLM returned >8 keywords per memory_map entry
    // and the whole digest fell back to the deterministic index.
    const overlong = JSON.stringify({
      profile: 'User works on the DUYA desktop agent.',
      top_rules: [],
      memory_map: [
        {
          topic: 'canvas tooling',
          keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10'],
          files: ['global/areas/canvas-tooling.md', 'f2.md', 'f3.md', 'f4.md', 'f5.md', 'f6.md', 'f7.md'],
        },
      ],
      gaps: [],
    });
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm(overlong),
    });
    expect(res.success).toBe(true);
    expect(res.content).toContain('## Who is this user');
    expect(res.content).toContain('canvas tooling');
    expect(res.content).toContain('k1, k2, k3, k4, k5, k6, k7, k8');
    expect(res.content).not.toContain('k9');
  });

  it('clamps oversized maps and out-of-range priorities instead of failing', async () => {
    const tooBig = JSON.stringify({
      profile: 'User works on the DUYA desktop agent.',
      top_rules: [
        { rule: 'R1', source: 's', priority: 99 },
        { rule: 'R2', source: 's' },
        { rule: '', source: 's' },
      ],
      memory_map: Array.from({ length: 20 }, (_, i) => ({
        topic: `topic-${i}`,
        keywords: ['kw'],
        files: ['f.md'],
      })),
      gaps: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'],
    });
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm(tooBig),
    });
    expect(res.success).toBe(true);
    expect(res.content).toContain('## Rules that matter');
    expect(res.content).toContain('**R1**');
    // priority 99 was clamped to 10, so R1 sorts before the unset R2 (99)
    expect(res.content.indexOf('**R1**')).toBeLessThan(res.content.indexOf('**R2**'));
  });

  it('still falls back when even the lenient parse cannot salvage the response', async () => {
    const broken = JSON.stringify({ profile: 123, top_rules: 'nope', memory_map: {}, gaps: 5 });
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm(broken),
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/lenient parse failed/);
    expect(res.content).toContain('Memory Summary');
  });

  it('returns success:false + deterministic fallback content on junk response', async () => {
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm('definitely not json'),
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/parse failed/);
    // fallback keeps summary.md non-empty with the deterministic index
    expect(res.content).toContain('Memory Summary');
    expect(res.content).toContain('Canvas MCP fallback');
  });

  it('returns success:false + deterministic fallback content on empty response', async () => {
    const res = await synthesizeSummary({
      memoryRoot: fx.memoryRoot,
      llmClient: mockLlm('   '),
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/empty/);
    expect(res.content).toContain('Memory Summary');
  });

  it('passes the CURRENT semantic digest into the prompt as the edit baseline', async () => {
    // Pre-write a good summary.md (semantic block + deterministic index).
    const prevDigest = [
      '## Who is this user',
      '',
      'User is a Chinese-speaking engineer building the DUYA desktop agent.',
      '',
      '## Rules that matter',
      '',
      '1. **When canvas locks, use the fallback.** — `global/areas/canvas-tooling.md`',
    ].join('\n');
    const index = [
      '## Essentials',
      '',
      '- **area:canvas-tooling**: ... → global/areas/canvas-tooling.md',
    ].join('\n');
    fs.writeFileSync(path.join(fx.memoryRoot, 'summary.md'), prevDigest + '\n\n' + index, 'utf8');

    const llm = mockLlmWithCapture(VALID_JSON);
    await synthesizeSummary({ memoryRoot: fx.memoryRoot, llmClient: llm });

    const prompt = llm.__lastUserPrompt();
    expect(prompt).toContain('current_semantic_summary');
    expect(prompt).toContain('User is a Chinese-speaking engineer building the DUYA desktop agent.');
    expect(prompt).toContain('When canvas locks, use the fallback.');
    expect(prompt).toContain('EDIT IN PLACE');
  });

  it('omits the edit baseline when no summary.md exists yet (first synthesis)', async () => {
    const llm = mockLlmWithCapture(VALID_JSON);
    await synthesizeSummary({ memoryRoot: fx.memoryRoot, llmClient: llm });

    const prompt = llm.__lastUserPrompt();
    expect(prompt).not.toContain('current_semantic_summary');
    expect(prompt).not.toContain('EDIT IN PLACE');
    expect(prompt).toContain('canvas-tooling.md'); // canonical files still present
  });
});
