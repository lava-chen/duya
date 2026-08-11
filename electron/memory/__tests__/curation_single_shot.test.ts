import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runSingleShotCuration } from '../curation_single_shot';
import type { AIClient, Message } from '@duya/ai';
import type { CurationInputForPrompt } from '../curation_single_shot';

/**
 * Minimal mock AIClient. Implements only `chat()`. `streamChat` is
 * present but should never be called (the single-shot path uses chat).
 */
function createMockLLMClient(reply: string | ((messages: Message[]) => string)): AIClient {
  let chatCalls = 0;
  const client: AIClient = {
    streamChat: undefined as unknown as AIClient['streamChat'],
    async chat(messages: Message[]) {
      chatCalls += 1;
      const content = typeof reply === 'function' ? reply(messages) : reply;
      return { content, usage: { input_tokens: 0, output_tokens: content.length } };
    },
  } as unknown as AIClient;
  (client as unknown as { __chatCalls: () => number }).__chatCalls = () => chatCalls;
  return client;
}

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cur-singleshot-'));
}

function seedRolloutSummary(root: string, id: string, body: string): void {
  const dir = path.join(root, 'rollout_summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), body, 'utf8');
}

function seedArea(root: string, areaPath: string, body: string): void {
  const absolute = path.join(root, areaPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body, 'utf8');
}

function readArea(root: string, areaPath: string): string {
  return fs.readFileSync(path.join(root, areaPath), 'utf8');
}

const VALID_REPLY = JSON.stringify({
  decisions: [
    { rollout_id: 'r-1', disposition: 'absorbed', reason: 'kept the rule' },
    { rollout_id: 'r-2', disposition: 'no_signal', reason: 'noise' },
  ],
  actions: [
    {
      op: 'append',
      area_path: 'global/areas/foo.md',
      content: '## rule\n- never lie',
      reason: 'r-1 confirmed',
    },
    {
      op: 'no_op',
      area_path: 'global/areas/foo.md',
      content: '',
      reason: 'r-2 had nothing',
    },
  ],
});

const inputs: CurationInputForPrompt[] = [
  { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'h1', outputUpdatedAt: 1, rolloutSlug: 'foo' },
  { inputKind: 'rollout', inputKey: 'r-2', contentHash: 'h2', outputUpdatedAt: 2, rolloutSlug: 'foo' },
];

describe('runSingleShotCuration — happy path', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
    seedRolloutSummary(root, 'r-1', '---\nrollout_id: r-1\n---\n\n# summary r-1\nrule: never lie');
    seedRolloutSummary(root, 'r-2', '---\nrollout_id: r-2\n---\n\n# summary r-2\nchitchat');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('1. parses reply + applies actions + reports counts', async () => {
    seedArea(root, 'global/areas/foo.md', '# foo\n\nexisting\n');
    const llm = createMockLLMClient(VALID_REPLY);
    const result = await runSingleShotCuration({
      memoryRoot: root,
      inputs,
      llmClient: llm,
    });

    expect(result.success).toBe(true);
    expect(result.response).not.toBeNull();
    expect(result.actionsApplied).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.rawResponse).toBe(VALID_REPLY);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const body = readArea(root, 'global/areas/foo.md');
    expect(body).toContain('existing');
    expect(body).toContain('## rule');
    expect(body).toContain('- never lie');
  });

  it('2. passes maxTokens=8192 + signal to chat()', async () => {
    seedArea(root, 'global/areas/foo.md', '# foo\n');
    let capturedOptions: Parameters<NonNullable<AIClient['chat']>>[1] | undefined;
    const llm = createMockLLMClient((_messages) => {
      return VALID_REPLY;
    });
    const wrapped: AIClient = {
      ...(llm as object),
    } as AIClient;
    // Spy by overriding chat
    const originalChat = (llm as { chat: NonNullable<AIClient['chat']> }).chat;
    (wrapped as unknown as { chat: NonNullable<AIClient['chat']> }).chat = async (m, opts) => {
      capturedOptions = opts;
      return originalChat.call(wrapped, m, opts);
    };
    await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: wrapped });
    expect(capturedOptions?.maxTokens).toBe(8192);
    expect(capturedOptions?.temperature).toBe(0.2);
    expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedOptions?.systemPrompt).toContain('Memory Curator');
  });

  it('3. user prompt contains rollout summaries + existing area', async () => {
    seedArea(root, 'global/areas/foo.md', '# foo existing');
    let captured: Message[] | undefined;
    const llm = createMockLLMClient((messages) => {
      captured = messages;
      return VALID_REPLY;
    });
    await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: llm });

    expect(captured).toBeDefined();
    const userMsg = captured![0];
    expect(userMsg.role).toBe('user');
    const payload = JSON.parse(userMsg.content as string);
    expect(payload.inputs).toHaveLength(2);
    expect(payload.inputs[0].rollout_id).toBe('r-1');
    expect(payload.inputs[0].summary_md).toContain('never lie');
    expect(payload.existing_areas['global/areas/foo.md']).toContain('foo existing');
  });

  it('3b. memory panorama lists every canonical file with bucket + recency', async () => {
    seedArea(root, 'global/areas/foo.md', '# Foo Area\n\n## Summary\n\nbody');
    seedArea(root, 'global/preferences/taste.md', '# Taste prefs\n\n## Summary\n\nbody');
    seedArea(root, 'global/people/alice.md', '# Alice\n\n## Summary\n\nbody');
    let captured: Message[] | undefined;
    const llm = createMockLLMClient((messages) => {
      captured = messages;
      return VALID_REPLY;
    });
    await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: llm });

    const payload = JSON.parse(captured![0].content as string);
    expect(payload.memory_panorama).toBeDefined();
    const files = payload.memory_panorama.files as Array<{ bucket: string; slug: string; title: string; updated: string }>;
    expect(files).toHaveLength(3);
    const bySlug = new Map(files.map((f) => [f.slug, f]));
    expect(bySlug.get('foo')?.bucket).toBe('areas');
    expect(bySlug.get('foo')?.title).toBe('Foo Area');
    expect(bySlug.get('taste')?.bucket).toBe('preferences');
    expect(bySlug.get('alice')?.bucket).toBe('people');
    expect(bySlug.get('foo')?.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('runSingleShotCuration — failure modes', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
    seedRolloutSummary(root, 'r-1', '# r-1');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('4. parse failure → success=false, error set, no files written', async () => {
    const llm = createMockLLMClient('not valid json');
    const result = await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: llm });

    expect(result.success).toBe(false);
    expect(result.response).toBeNull();
    expect(result.error).toMatch(/parse failed/);
    expect(result.actionsApplied).toBe(0);
    expect(fs.existsSync(path.join(root, 'global/areas/foo.md'))).toBe(false);
  });

  it('5. empty LLM response → treated as uncertain (no error)', async () => {
    const llm = createMockLLMClient('   ');
    const result = await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: llm });

    expect(result.success).toBe(true);
    expect(result.response).not.toBeNull();
    expect(result.response!.decisions.every((d) => d.disposition === 'uncertain')).toBe(true);
    expect(result.actionsApplied).toBe(0);
  });

  it('6. LLM response with bad area_path is rejected by Zod', async () => {
    const llm = createMockLLMClient(JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [{
        op: 'append',
        area_path: '../../etc/passwd',
        content: 'pwn',
        reason: 'attempted escape',
      }],
    }));
    const result = await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: llm });

    expect(result.success).toBe(false);
    // Parser rejects the bad path before the file writer sees it.
    expect(result.response).toBeNull();
    expect(result.error).toMatch(/parse failed/);
    expect(result.actionsApplied).toBe(0);
    expect(fs.existsSync(path.join(root, 'global/areas'))).toBe(false);
  });

  it('6b. LLM response with sub-area append works on disk', async () => {
    seedArea(root, 'global/areas/foo.md', '# foo existing\n');
    const llm = createMockLLMClient(JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [{
        op: 'append',
        area_path: 'global/areas/foo.md',
        content: '## rule\n- new',
        reason: 'r',
      }],
    }));
    const result = await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: llm });
    expect(result.success).toBe(true);
    expect(result.actionsApplied).toBe(1);
    expect(readArea(root, 'global/areas/foo.md')).toContain('existing');
    expect(readArea(root, 'global/areas/foo.md')).toContain('- new');
  });

  it('7. timeout → error mentions timeout', async () => {
    // honor the abort signal so we don't actually wait 10s
    const llm: AIClient = {
      async chat(_messages, opts) {
        return new Promise((resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          // never resolves otherwise
        });
      },
    } as unknown as AIClient;
    const result = await runSingleShotCuration({
      memoryRoot: root,
      inputs,
      llmClient: llm,
      timeoutMs: 50,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out|aborted/i);
  });
});

describe('runSingleShotCuration — stage1_policy adaptive loop', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
    seedRolloutSummary(root, 'r-1', '# r-1 with plan signals');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('9. LLM emits stage1_policy.update → policy file written + version bumped', async () => {
    const policyDir = path.join(root, 'memory-config');
    fs.mkdirSync(policyDir, { recursive: true });
    const policyPath = path.join(policyDir, 'stage1_policy.md');
    fs.writeFileSync(policyPath + '.version', '3', 'utf8');

    const llm = createMockLLMClient(JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'no_signal', reason: 'no durable claim' }],
      actions: [],
      stage1_policy: {
        op: 'update',
        content: '# Focus\n\nWatch goal and commitment signals from user planning talk.',
        reason: 'user keeps discussing career plans; summaries miss them',
      },
    }));

    const result = await runSingleShotCuration({
      memoryRoot: root,
      inputs,
      llmClient: llm,
      policyPath,
    });

    expect(result.success).toBe(true);
    expect(result.policyUpdated).toBe(true);
    expect(result.policyVersion).toBe(4); // bumped 3 -> 4
    expect(fs.readFileSync(policyPath, 'utf8')).toContain('goal and commitment');
    expect(fs.readFileSync(policyPath + '.version', 'utf8').trim()).toBe('4');
  });

  it('10. stage1_policy.no_change → policy file untouched', async () => {
    const policyDir = path.join(root, 'memory-config');
    fs.mkdirSync(policyDir, { recursive: true });
    const policyPath = path.join(policyDir, 'stage1_policy.md');
    fs.writeFileSync(policyPath, 'old policy', 'utf8');
    fs.writeFileSync(policyPath + '.version', '2', 'utf8');

    const llm = createMockLLMClient(JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'no_signal', reason: 'noise' }],
      actions: [],
      stage1_policy: { op: 'no_change' },
    }));

    const result = await runSingleShotCuration({
      memoryRoot: root,
      inputs,
      llmClient: llm,
      policyPath,
    });

    expect(result.success).toBe(true);
    expect(result.policyUpdated).toBeUndefined();
    expect(fs.readFileSync(policyPath, 'utf8')).toBe('old policy');
    expect(fs.readFileSync(policyPath + '.version', 'utf8').trim()).toBe('2');
  });

  it('11. no policyPath provided → suggestion ignored silently', async () => {
    const llm = createMockLLMClient(JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'no_signal', reason: 'noise' }],
      actions: [],
      stage1_policy: {
        op: 'update',
        content: 'x',
        reason: 'y',
      },
    }));

    const result = await runSingleShotCuration({
      memoryRoot: root,
      inputs,
      llmClient: llm,
    });

    expect(result.success).toBe(true);
    expect(result.policyUpdated).toBeUndefined();
  });

  it('12. new_categories creates the directory + actions land inside it', async () => {
    const llm = createMockLLMClient(JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'learner profile' }],
      actions: [{
        op: 'append',
        area_path: 'global/lessons/math-101.md',
        content: '## Course\n- user is studying calculus',
        reason: 'learner dimension',
      }],
      new_categories: [{
        name: 'lessons',
        reason: 'user activity is mostly coursework across many sessions',
      }],
    }));

    const result = await runSingleShotCuration({ memoryRoot: root, inputs, llmClient: llm });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, 'global/lessons'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'global/lessons/math-101.md'), 'utf8')).toContain('calculus');
  });
});

describe('runSingleShotCuration — empty input set', () => {
  it('8. empty inputs → LLM still called; actions that target valid areas land', async () => {
    const root = mkRoot();
    try {
      const llm = createMockLLMClient(VALID_REPLY);
      const result = await runSingleShotCuration({
        memoryRoot: root,
        inputs: [],
        llmClient: llm,
      });
      // The single-shot layer is intentionally permissive: even with no
      // inputs, the LLM may emit decisions/actions based on whatever it
      // decides to do. We don't refuse empty input — the cycle caller
      // (`runCurationCycle`) already enforces `MIN_INPUTS_FOR_RUN`.
      expect(result.actionsApplied).toBe(1);
      expect(readArea(root, 'global/areas/foo.md')).toContain('## rule');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});