/**
 * Plan 577 Phase 3 — ContextComposition accounting ("context is not just
 * messages").
 *
 * Locks:
 * ① the bucket taxonomy (conversation / injectedContext / toolResults /
 *    attachments / system / toolDefinitions / memory) with the
 *    `injectedContext` bucket the second review round added — harness
 *    injections stop being invisible inside "conversation";
 * ② the unanchored estimate charges tool definitions once; on the anchored
 *    path, local message/system/tool estimates explain the provider total
 *    without charging them a second time;
 * ③ the composition is a projection of the SAME measurement:
 *    buckets + unattributedObservedTokens === estimate.usedTokens.
 */

import { describe, it, expect } from 'vitest';
import {
  computeContextComposition,
  contextPartsTotal,
  IMAGE_TOKEN_FLOOR,
  type ContextEstimateMessage,
} from '../src/utils/context-estimate.js';

function assistantAnchor(inputTokens: number, outputTokens: number): ContextEstimateMessage {
  return {
    role: 'assistant',
    content: 'answer',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe('ContextComposition bucketing', () => {
  it('routes blocks into conversation / toolResults / attachments / injectedContext', () => {
    // Provider usage remains the headline authority. Local estimates for the
    // prompt, system and tool definitions explain that anchor without adding
    // them to the headline again.
    const messages: ContextEstimateMessage[] = [
      { role: 'user', content: 'prior context' },
      assistantAnchor(10_000, 500),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'plain user question' },
          { type: 'text', text: '<system-reminder>runtime injected guidance</system-reminder>' },
          { type: 'tool_result', tool_use_id: 't1', content: 'tool output text' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        ],
      },
    ];

    const { estimate, composition } = computeContextComposition(messages, {
      systemPrefixTokens: 1_000,
      toolDefinitionsTokens: 2_000,
    });
    expect(estimate.anchored).toBe(true);
    expect(contextPartsTotal(composition.system)).toBe(1_000);
    expect(contextPartsTotal(composition.toolDefinitions)).toBe(2_000);
    // Prompt history + persisted answer + the trailing text are conversation.
    expect(composition.conversation.length).toBe(3);
    expect(composition.injectedContext.length).toBe(1);
    expect(composition.toolResults.length).toBe(1);
    expect(composition.attachments.length).toBe(1);
    expect(composition.attachments[0].tokens).toBe(IMAGE_TOKEN_FLOOR);
    // Sum invariant: buckets + unattributed === total.
    const bucketSum =
      contextPartsTotal(composition.system) +
      contextPartsTotal(composition.conversation) +
      contextPartsTotal(composition.injectedContext) +
      contextPartsTotal(composition.toolDefinitions) +
      contextPartsTotal(composition.toolResults) +
      contextPartsTotal(composition.attachments) +
      contextPartsTotal(composition.memory);
    expect(composition.unattributedObservedTokens + bucketSum).toBe(estimate.usedTokens);
  });

  it('classifies a string-content harness injection as injectedContext', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(1_000, 100),
      { role: 'user', content: '[system] background task finished' },
    ];
    const { composition } = computeContextComposition(messages);
    expect(composition.injectedContext.length).toBe(1);
    // The anchored assistant response itself is persisted into the next prompt.
    expect(composition.conversation.length).toBe(1);
  });

  it('unanchored path: tool definitions are priced once and land in the bucket', () => {
    const messages: ContextEstimateMessage[] = [
      { role: 'user', content: 'hello world' },
    ];
    const { estimate, composition } = computeContextComposition(messages, {
      systemPrefixTokens: 1_000,
      toolDefinitionsTokens: 12_000,
    });
    expect(estimate.anchored).toBe(false);
    // used = history(≈3) + system(1000) + tools(12000)
    expect(estimate.usedTokens).toBe(estimate.trailingTokens + 1_000 + 12_000);
    expect(estimate.toolDefinitionsTokens).toBe(12_000);
    expect(contextPartsTotal(composition.toolDefinitions)).toBe(12_000);
    expect(contextPartsTotal(composition.system)).toBe(1_000);
  });

  it('anchored path labels estimated tool definitions without charging them twice', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(50_000, 1_000),
      { role: 'user', content: 'follow-up' },
    ];
    const { estimate, composition } = computeContextComposition(messages, {
      toolDefinitionsTokens: 12_000,
    });
    expect(estimate.anchored).toBe(true);
    expect(estimate.toolDefinitionsTokens).toBe(0);
    expect(contextPartsTotal(composition.toolDefinitions)).toBe(12_000);
    // 50k input + persisted "answer" (2 tokens) + trailing follow-up — the
    // local tool estimate is a category, not an extra charge to the headline.
    expect(estimate.usedTokens).toBe(50_002 + estimate.trailingTokens);
    const attributed =
      contextPartsTotal(composition.system) +
      contextPartsTotal(composition.conversation) +
      contextPartsTotal(composition.injectedContext) +
      contextPartsTotal(composition.toolDefinitions) +
      contextPartsTotal(composition.toolResults) +
      contextPartsTotal(composition.attachments) +
      contextPartsTotal(composition.memory);
    expect(composition.unattributedObservedTokens + attributed).toBe(estimate.usedTokens);
  });

  it('scales local categories when they exceed the provider anchor', () => {
    const messages = [assistantAnchor(100, 10)];
    const { estimate, composition } = computeContextComposition(messages, {
      systemPrefixTokens: 1_000,
      toolDefinitionsTokens: 1_000,
    });
    const attributed =
      contextPartsTotal(composition.system) +
      contextPartsTotal(composition.conversation) +
      contextPartsTotal(composition.injectedContext) +
      contextPartsTotal(composition.toolDefinitions) +
      contextPartsTotal(composition.toolResults) +
      contextPartsTotal(composition.attachments) +
      contextPartsTotal(composition.memory);
    expect(attributed).toBeLessThanOrEqual(estimate.anchorTokens);
    expect(composition.unattributedObservedTokens + attributed).toBe(estimate.usedTokens);
  });

  it('systemParts / memoryParts label their buckets when provided', () => {
    const messages: ContextEstimateMessage[] = [{ role: 'user', content: 'hi' }];
    const { composition } = computeContextComposition(messages, {
      systemParts: [
        { label: 'core prompt', tokens: 800 },
        { label: 'skills', tokens: 200 },
      ],
      memoryParts: [{ label: 'MEMORY.md', tokens: 700 }],
      toolDefinitionsTokens: 5_000,
      toolDefinitionParts: [
        { label: 'builtin', tokens: 2_000 },
        { label: 'mcp:github', tokens: 3_000 },
      ],
    });
    expect(composition.system).toEqual([
      { label: 'core prompt', tokens: 800 },
      { label: 'skills', tokens: 200 },
    ]);
    expect(composition.memory).toEqual([{ label: 'MEMORY.md', tokens: 700 }]);
    expect(composition.toolDefinitions).toEqual([
      { label: 'builtin', tokens: 2_000 },
      { label: 'mcp:github', tokens: 3_000 },
    ]);
  });

  it('post-compaction "?" estimate yields empty buckets', () => {
    const messages: ContextEstimateMessage[] = [
      { role: 'assistant', content: 'old', usage: { input_tokens: 90_000, output_tokens: 10 }, isCompactBoundary: true },
      { role: 'user', content: 'new question after compaction' },
    ];
    const { estimate, composition } = computeContextComposition(messages);
    expect(estimate.usedTokens).toBeNull();
    expect(composition.conversation).toEqual([]);
    expect(composition.unattributedObservedTokens).toBe(0);
  });
});

describe('ContextComposition skills bucket (plan 579)', () => {
  it('attributes a Skill tool result to its skill via the tool_use id', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 100),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'docx' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'sk1', content: '{"success":true,"commandName":"docx","content":"..."}' },
        ],
      },
    ];
    const { composition } = computeContextComposition(messages);
    expect(composition.skills.length).toBe(1);
    expect(composition.skills[0].label).toBe('skill:docx');
    expect(composition.skills[0].tokens).toBeGreaterThan(0);
    expect(composition.toolResults.length).toBe(0);
  });

  it('attributes a Read of SKILL.md to the skill directory name', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 100),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'C:\\Users\\me\\.duya\\skills\\pptx\\SKILL.md' } },
          // A regular read in the same message must stay in toolResults.
          { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'src/index.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'r1', content: 'File: ...\\SKILL.md\n\nskill body' },
          { type: 'tool_result', tool_use_id: 'r2', content: 'regular file body' },
        ],
      },
    ];
    const { composition } = computeContextComposition(messages);
    expect(composition.skills.length).toBe(1);
    expect(composition.skills[0].label).toBe('skill:pptx');
    expect(composition.toolResults.length).toBe(1);
  });

  it('routes <skill> mention injections into the skills bucket', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 100),
      {
        role: 'user',
        content: [
          { type: 'text', text: '<skill>\n<name>pdf</name>\n<location>/skills/pdf/SKILL.md</location>\n\nPDF skill body' },
          { type: 'text', text: '<skill-suggestion>maybe use pdf</skill-suggestion>' },
        ],
      },
    ];
    const { composition } = computeContextComposition(messages);
    expect(composition.skills.length).toBe(1);
    expect(composition.skills[0].label).toBe('skill:pdf');
    // Suggestions are hints, not loaded bodies — they stay in injectedContext.
    expect(composition.injectedContext.length).toBe(1);
  });

  it('keeps the sum invariant with the skills bucket included', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(8_000, 100),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'sk9', name: 'Skill', input: { skill: '/xlsx' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'sk9', content: 'skill instructions' }],
      },
      // Single-block message: per-block ceil === per-message ceil, so the
      // sum invariant holds without rounding drift (multi-block messages
      // can drift ±1 token between the two granularities).
      { role: 'user', content: [{ type: 'text', text: 'plain text' }] },
    ];
    const { estimate, composition } = computeContextComposition(messages);
    expect(composition.skills[0].label).toBe('skill:xlsx');
    const attributed =
      contextPartsTotal(composition.system) +
      contextPartsTotal(composition.conversation) +
      contextPartsTotal(composition.injectedContext) +
      contextPartsTotal(composition.skills) +
      contextPartsTotal(composition.toolDefinitions) +
      contextPartsTotal(composition.toolResults) +
      contextPartsTotal(composition.attachments) +
      contextPartsTotal(composition.memory);
    expect(composition.unattributedObservedTokens + attributed).toBe(estimate.usedTokens);
  });

  it('merges skillParts (transient mention injections) into the skills bucket', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(20_000, 100),
      { role: 'user', content: 'use it now' },
    ];
    const { estimate, composition } = computeContextComposition(messages, {
      skillParts: [{ label: 'skill:commit', tokens: 900 }],
    });
    // The projection-rail body is inside the provider anchor — labelled but
    // never charged twice.
    expect(estimate.usedTokens).toBe(20_002 + estimate.trailingTokens);
    expect(composition.skills).toEqual([{ label: 'skill:commit', tokens: 900 }]);
    expect(composition.unattributedObservedTokens + composition.skills[0].tokens)
      .toBeLessThanOrEqual(estimate.anchorTokens);
  });
});

describe('ContextComposition connector/MCP tool-result attribution', () => {
  it('attributes a tool_invoke result to its connector via the stable tool ID', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 100),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'inv1', name: 'tool_invoke', input: { tool_id: 'connector:slack:post_message', arguments: { channel: 'general' } } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'inv1', content: '{"success":true}' }],
      },
    ];
    const { composition } = computeContextComposition(messages);
    expect(composition.toolResults.length).toBe(1);
    expect(composition.toolResults[0].label).toBe('connector:slack');
    expect(composition.toolResults[0].tokens).toBeGreaterThan(0);
  });

  it('attributes tool_invoke results to MCP servers and keeps builtin deferred calls generic', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 100),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'm1', name: 'tool_invoke', input: { tool_id: 'mcp:github:create_issue', arguments: {} } },
          { type: 'tool_use', id: 'b1', name: 'tool_invoke', input: { tool_id: 'builtin:read:read', arguments: {} } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'm1', content: 'issue created' },
          { type: 'tool_result', tool_use_id: 'b1', content: 'file body' },
        ],
      },
    ];
    const { composition } = computeContextComposition(messages);
    expect(composition.toolResults.length).toBe(2);
    const labels = composition.toolResults.map((part) => part.label).sort();
    expect(labels).toEqual([
      'mcp:github',
      expect.stringMatching(/^user#\d+\.\d+$/),
    ]);
  });

  it('attributes eager mcp_<server>_<tool> names and remote connector aliases', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 100),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'e1', name: 'mcp_github_create_issue', input: {} },
          // The FIRST token is the server (tool names are multi-word) —
          // both github tools attribute to the same source.
          { type: 'tool_use', id: 'e2', name: 'mcp_github_repo_list', input: {} },
          { type: 'tool_use', id: 'e3', name: 'remote_notion_create_page', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'e1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'e2', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'e3', content: 'ok' },
        ],
      },
    ];
    const { composition } = computeContextComposition(messages);
    const labels = composition.toolResults.map((part) => part.label).sort();
    expect(labels).toEqual(['connector:notion', 'mcp:github', 'mcp:github']);
  });

  it('keeps the sum invariant with attributed tool results', () => {
    const messages: ContextEstimateMessage[] = [
      assistantAnchor(10_000, 100),
      {
        role: 'assistant',
        content: [
          // Plugin-owned MCP sources encode `pluginId:connection` inside the
          // source segment (createToolId) — the label keeps the full id.
          { type: 'tool_use', id: 'inv2', name: 'tool_invoke', input: { tool_id: 'plugin:figma%3Amain:list_files', arguments: {} } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'inv2', content: 'files' }] },
    ];
    const { estimate, composition } = computeContextComposition(messages);
    expect(composition.toolResults[0].label).toBe('plugin:figma:main');
    const attributed =
      contextPartsTotal(composition.system) +
      contextPartsTotal(composition.conversation) +
      contextPartsTotal(composition.injectedContext) +
      contextPartsTotal(composition.skills) +
      contextPartsTotal(composition.toolDefinitions) +
      contextPartsTotal(composition.toolResults) +
      contextPartsTotal(composition.attachments) +
      contextPartsTotal(composition.memory);
    expect(composition.unattributedObservedTokens + attributed).toBe(estimate.usedTokens);
  });
});
