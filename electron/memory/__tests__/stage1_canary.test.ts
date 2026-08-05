import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadFixtures, type CanaryFixture } from '../stage1_canary';
import { runCanary, type CanaryResult } from '../stage1_canary';
import { STAGE1_HARD_CONTRACT, assembleStage1Prompt } from '../../../packages/agent/src/memory-rollout/stage1_prompt_loader';
import type { AIClient } from '@duya/ai';
import { promotePolicy } from '../stage1_canary';
import { triggerPostCurationCanary } from '../stage1_canary';

interface CanaryEnv {
  dir: string;
  cleanup: () => void;
}

function makeEnv(): CanaryEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fixtures-'));
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

describe('loadFixtures', () => {
  let env: CanaryEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('returns fixtures array when directory contains valid fixture JSON files', async () => {
    const fixturesDir = path.join(env.dir, 'fixtures');
    fs.mkdirSync(fixturesDir, { recursive: true });
    const fixture: CanaryFixture = {
      fixture_id: 'fix-001',
      transcript: 'User said: reply in Chinese from now on.',
      expected_required_keys: ['preference:response-language'],
      forbidden_keys: ['person:transient'],
      allowed_empty: false,
      expected_scope: { 'preference:response-language': 'personal' },
      expected_kind: { 'preference:response-language': 'preference' },
      schema_invariant: 'all items must have canonical_key + evidence',
    };
    fs.writeFileSync(path.join(fixturesDir, 'fix-001.json'), JSON.stringify(fixture), 'utf8');

    const result = await loadFixtures(fixturesDir);

    expect(result).toHaveLength(1);
    expect(result[0].fixture_id).toBe('fix-001');
    expect(result[0].expected_required_keys).toEqual(['preference:response-language']);
  });

  it('returns empty array when directory does not exist', async () => {
    const result = await loadFixtures(path.join(env.dir, 'nonexistent'));

    expect(result).toEqual([]);
  });

  it('returns empty array when directory has no .json files', async () => {
    const fixturesDir = path.join(env.dir, 'fixtures');
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(path.join(fixturesDir, 'readme.txt'), 'not a fixture', 'utf8');

    const result = await loadFixtures(fixturesDir);

    expect(result).toEqual([]);
  });

  it('skips fixture files that fail to parse as CanaryFixture', async () => {
    const fixturesDir = path.join(env.dir, 'fixtures');
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(path.join(fixturesDir, 'broken.json'), '{ not valid json', 'utf8');
    const valid: CanaryFixture = {
      fixture_id: 'fix-002',
      transcript: 'valid transcript',
      expected_required_keys: [],
      forbidden_keys: [],
      allowed_empty: true,
      expected_scope: {},
      expected_kind: {},
      schema_invariant: '',
    };
    fs.writeFileSync(path.join(fixturesDir, 'fix-002.json'), JSON.stringify(valid), 'utf8');

    const result = await loadFixtures(fixturesDir);

    expect(result).toHaveLength(1);
    expect(result[0].fixture_id).toBe('fix-002');
  });
});

function makeMockLLM(responseJson: string): AIClient {
  const mock: Partial<AIClient> = {
    async *streamChat(_messages, _options) {
      yield { type: 'text', data: responseJson };
    },
  };
  return mock as AIClient;
}

const VALID_RESPONSE_WITH_PREFERENCE = JSON.stringify({
  job_status: 'succeeded',
  content_outcome: 'success',
  rollout_summary: 'User set reply language preference.',
  rollout_slug: 'reply-language',
  raw_memory: {
    items: [
      {
        claim: 'User prefers Chinese replies',
        claim_type: 'preference',
        scope: 'personal',
        scope_id: null,
        evidence: [{ source_type: 'user_message', source_id: 'msg-1', verification: 'verified_user' }],
        canonical_key: 'preference:response-language',
        confidence: 'high',
        status: 'active',
        valid_from: null,
        valid_until: null,
        relation_to_existing: null,
        supersedes: [],
        why_future_agent_needs_this: 'so the agent replies in the right language',
        retrieval_cues: ['chinese', 'language'],
      },
    ],
  },
});

const VALID_RESPONSE_EMPTY = JSON.stringify({
  job_status: 'succeeded',
  content_outcome: 'success',
  rollout_summary: 'No durable knowledge.',
  rollout_slug: 'noop',
  raw_memory: { items: [] },
});

describe('runCanary', () => {
  const fixtures: CanaryFixture[] = [
    {
      fixture_id: 'fix-001',
      transcript: 'User said: reply in Chinese from now on.',
      expected_required_keys: ['preference:response-language'],
      forbidden_keys: ['person:transient'],
      allowed_empty: false,
      expected_scope: {},
      expected_kind: {},
      schema_invariant: '',
    },
  ];

  it('passes when all required keys present, no forbidden keys, schema valid', async () => {
    const llmClient = makeMockLLM(VALID_RESPONSE_WITH_PREFERENCE);
    const policy = '# Focus on preferences';

    const result = await runCanary({
      candidatePolicy: policy,
      fixtures,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.metrics.schemaSuccessRate).toBe(1.0);
    expect(result.metrics.requiredKeysRecall).toBe(1.0);
    expect(result.metrics.forbiddenKeysPrecision).toBe(1.0);
  });

  it('fails when a required key is missing from the LLM output', async () => {
    // LLM returns empty items — required key 'preference:response-language' is missing
    const llmClient = makeMockLLM(VALID_RESPONSE_EMPTY);

    const result = await runCanary({
      candidatePolicy: '# any policy',
      fixtures,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toMatch(/required/);
    expect(result.failures.join('\n')).toMatch('preference:response-language');
    expect(result.metrics.requiredKeysRecall).toBe(0.0);
  });

  it('fails when a forbidden key appears in the LLM output', async () => {
    const responseWithForbidden = JSON.stringify({
      job_status: 'succeeded',
      content_outcome: 'success',
      rollout_summary: 'User mentioned a person.',
      rollout_slug: 'person-mention',
      raw_memory: {
        items: [
          {
            claim: 'There is a person',
            claim_type: 'preference',
            scope: 'personal',
            scope_id: null,
            evidence: [{ source_type: 'user_message', source_id: 'msg-1', verification: 'verified_user' }],
            canonical_key: 'preference:response-language',
            confidence: 'high',
            status: 'active',
            valid_from: null,
            valid_until: null,
            relation_to_existing: null,
            supersedes: [],
            why_future_agent_needs_this: 'reason',
            retrieval_cues: [],
          },
          {
            claim: 'Transient person',
            claim_type: 'person',
            scope: 'personal',
            scope_id: null,
            evidence: [{ source_type: 'user_message', source_id: 'msg-2', verification: 'observed' }],
            canonical_key: 'person:transient',
            confidence: 'low',
            status: 'draft',
            valid_from: null,
            valid_until: null,
            relation_to_existing: null,
            supersedes: [],
            why_future_agent_needs_this: 'reason',
            retrieval_cues: [],
          },
        ],
      },
    });
    const llmClient = makeMockLLM(responseWithForbidden);

    const result = await runCanary({
      candidatePolicy: '# any policy',
      fixtures,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toMatch(/forbidden/);
    expect(result.failures.join('\n')).toMatch('person:transient');
    expect(result.metrics.forbiddenKeysPrecision).toBeLessThan(1.0);
  });

  it('fails when LLM output is not valid JSON (schema failure)', async () => {
    const llmClient = makeMockLLM('not json at all');

    const result = await runCanary({
      candidatePolicy: '# any policy',
      fixtures,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toMatch(/schema|parse/i);
    expect(result.metrics.schemaSuccessRate).toBe(0.0);
  });

  it('passes when allowed_empty=true and LLM returns no items', async () => {
    const emptyFixture: CanaryFixture[] = [
      { ...fixtures[0], allowed_empty: true, expected_required_keys: [] },
    ];
    const llmClient = makeMockLLM(VALID_RESPONSE_EMPTY);

    const result = await runCanary({
      candidatePolicy: '# any policy',
      fixtures: emptyFixture,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.passed).toBe(true);
  });
});

describe('promotePolicy', () => {
  let env: CanaryEnv;
  let fixturesDir: string;
  let livePolicyDir: string;
  let proposalsDir: string;

  beforeEach(() => {
    env = makeEnv();
    fixturesDir = path.join(env.dir, 'fixtures');
    livePolicyDir = path.join(env.dir, 'config');
    proposalsDir = path.join(livePolicyDir, 'policy_proposals');
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.mkdirSync(livePolicyDir, { recursive: true });
    fs.mkdirSync(proposalsDir, { recursive: true });
    // Seed a fixture
    fs.writeFileSync(
      path.join(fixturesDir, 'fix-001.json'),
      JSON.stringify({
        fixture_id: 'fix-001',
        transcript: 'User said: reply in Chinese.',
        expected_required_keys: ['preference:response-language'],
        forbidden_keys: [],
        allowed_empty: false,
        expected_scope: {},
        expected_kind: {},
        schema_invariant: '',
      }),
      'utf8',
    );
  });
  afterEach(() => { env.cleanup(); });

  it('promotes the candidate when canary passes, bumps version, removes proposal', async () => {
    const proposalPath = path.join(proposalsDir, 'prop-001.candidate.md');
    const livePolicyPath = path.join(livePolicyDir, 'stage1_policy.md');
    const candidateContent = '# Candidate policy v-next';
    fs.writeFileSync(proposalPath, candidateContent, 'utf8');
    // Existing live policy at v3
    fs.writeFileSync(livePolicyPath, '# Old policy', 'utf8');
    fs.writeFileSync(`${livePolicyPath}.version`, '3', 'utf8');

    const fixtures = await loadFixtures(fixturesDir);
    const llmClient = makeMockLLM(VALID_RESPONSE_WITH_PREFERENCE);

    const result = await promotePolicy({
      proposalPath,
      livePolicyPath,
      fixtures,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.promoted).toBe(true);
    expect(result.result.passed).toBe(true);

    // Live policy content replaced
    const newContent = fs.readFileSync(livePolicyPath, 'utf8');
    expect(newContent).toBe(candidateContent);
    // Version bumped to 4
    const newVersion = fs.readFileSync(`${livePolicyPath}.version`, 'utf8');
    expect(parseInt(newVersion.trim(), 10)).toBe(4);
    // Proposal file removed
    expect(fs.existsSync(proposalPath)).toBe(false);
  });

  it('does NOT promote when canary fails; deletes the proposal; live policy unchanged', async () => {
    const proposalPath = path.join(proposalsDir, 'prop-002.candidate.md');
    const livePolicyPath = path.join(livePolicyDir, 'stage1_policy.md');
    const oldContent = '# Old policy v3';
    fs.writeFileSync(proposalPath, '# Bad candidate', 'utf8');
    fs.writeFileSync(livePolicyPath, oldContent, 'utf8');
    fs.writeFileSync(`${livePolicyPath}.version`, '3', 'utf8');

    const fixtures = await loadFixtures(fixturesDir);
    // LLM returns empty items — required key missing, canary fails
    const llmClient = makeMockLLM(VALID_RESPONSE_EMPTY);

    const result = await promotePolicy({
      proposalPath,
      livePolicyPath,
      fixtures,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.promoted).toBe(false);
    expect(result.result.passed).toBe(false);

    // Live policy unchanged
    const content = fs.readFileSync(livePolicyPath, 'utf8');
    expect(content).toBe(oldContent);
    const version = fs.readFileSync(`${livePolicyPath}.version`, 'utf8');
    expect(version.trim()).toBe('3');
    // Proposal deleted
    expect(fs.existsSync(proposalPath)).toBe(false);
  });

  it('starts version at 1 when no prior version sidecar exists', async () => {
    const proposalPath = path.join(proposalsDir, 'prop-003.candidate.md');
    const livePolicyPath = path.join(livePolicyDir, 'stage1_policy.md');
    fs.writeFileSync(proposalPath, '# First policy', 'utf8');
    // No live policy + no version sidecar yet

    const fixtures = await loadFixtures(fixturesDir);
    const llmClient = makeMockLLM(VALID_RESPONSE_WITH_PREFERENCE);

    const result = await promotePolicy({
      proposalPath,
      livePolicyPath,
      fixtures,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(result.promoted).toBe(true);
    const version = fs.readFileSync(`${livePolicyPath}.version`, 'utf8');
    expect(parseInt(version.trim(), 10)).toBe(1);
  });
});

describe('triggerPostCurationCanary', () => {
  let env: CanaryEnv;
  let configRoot: string;
  let proposalsDir: string;
  let fixturesDir: string;
  let livePolicyPath: string;

  beforeEach(() => {
    env = makeEnv();
    configRoot = path.join(env.dir, 'memory-config');
    proposalsDir = path.join(configRoot, 'policy_proposals');
    fixturesDir = path.join(configRoot, '.canary', 'fixtures');
    livePolicyPath = path.join(configRoot, 'stage1_policy.md');
    fs.mkdirSync(proposalsDir, { recursive: true });
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixturesDir, 'fix-001.json'),
      JSON.stringify({
        fixture_id: 'fix-001',
        transcript: 'User said: reply in Chinese.',
        expected_required_keys: ['preference:response-language'],
        forbidden_keys: [],
        allowed_empty: false,
        expected_scope: {},
        expected_kind: {},
        schema_invariant: '',
      }),
      'utf8',
    );
  });
  afterEach(() => { env.cleanup(); });

  it('triggers canary + promotes when a proposal exists and canary passes', async () => {
    const proposalPath = path.join(proposalsDir, 'prop-001.candidate.md');
    fs.writeFileSync(proposalPath, '# Good candidate', 'utf8');

    const llmClient = makeMockLLM(VALID_RESPONSE_WITH_PREFERENCE);

    const results = await triggerPostCurationCanary({
      configRoot,
      fixturesDir,
      livePolicyPath,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(results).toHaveLength(1);
    expect(results[0].promoted).toBe(true);
    // Proposal consumed
    expect(fs.existsSync(proposalPath)).toBe(false);
    // Live policy updated
    expect(fs.readFileSync(livePolicyPath, 'utf8')).toBe('# Good candidate');
  });

  it('skips when no proposals exist (returns empty array, does not throw)', async () => {
    const llmClient = makeMockLLM(VALID_RESPONSE_WITH_PREFERENCE);

    const results = await triggerPostCurationCanary({
      configRoot,
      fixturesDir,
      livePolicyPath,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(results).toEqual([]);
  });

  it('processes multiple proposals independently', async () => {
    fs.writeFileSync(path.join(proposalsDir, 'prop-a.candidate.md'), '# A', 'utf8');
    fs.writeFileSync(path.join(proposalsDir, 'prop-b.candidate.md'), '# B', 'utf8');
    const llmClient = makeMockLLM(VALID_RESPONSE_WITH_PREFERENCE);

    const results = await triggerPostCurationCanary({
      configRoot,
      fixturesDir,
      livePolicyPath,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(results).toHaveLength(2);
    // Both promoted (canary passes for both); only the last one wins as live policy.
    expect(results[0].promoted).toBe(true);
    expect(results[1].promoted).toBe(true);
    // Proposals consumed
    expect(fs.existsSync(path.join(proposalsDir, 'prop-a.candidate.md'))).toBe(false);
    expect(fs.existsSync(path.join(proposalsDir, 'prop-b.candidate.md'))).toBe(false);
  });

  it('does not throw when proposalsDir does not exist', async () => {
    const llmClient = makeMockLLM(VALID_RESPONSE_WITH_PREFERENCE);

    const results = await triggerPostCurationCanary({
      configRoot: env.dir, // no policy_proposals subdir here
      fixturesDir,
      livePolicyPath,
      llmClient,
      hardContract: STAGE1_HARD_CONTRACT,
    });

    expect(results).toEqual([]);
  });
});