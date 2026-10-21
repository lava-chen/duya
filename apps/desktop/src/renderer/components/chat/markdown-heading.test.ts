import { describe, expect, it } from 'vitest';
import { preprocessMarkdownHeadings } from './MarkdownRenderer';

describe('preprocessMarkdownHeadings', () => {
  it('adds a space after a heading marker with no following space', () => {
    const input = '###现实可行的组合1. **Pruned + NVFP4**：11.67 GB\n2. 下一项';
    const out = preprocessMarkdownHeadings(input);
    expect(out).toBe('### 现实可行的组合1. **Pruned + NVFP4**：11.67 GB\n2. 下一项');
  });

  it('inserts a newline before a heading glued to the previous line', () => {
    const input = '## 仓库包含什么### 1. **Models（模型）**\n- 官方：`MiniMaxAI`';
    const out = preprocessMarkdownHeadings(input);
    expect(out).toBe('## 仓库包含什么\n### 1. **Models（模型）**\n- 官方：`MiniMaxAI`');
  });

  it('leaves already-valid headings untouched', () => {
    const input = '正常段落\n\n### 正确的标题\n- 列表项';
    expect(preprocessMarkdownHeadings(input)).toBe(input);
  });

  it('does not rewrite fenced code blocks', () => {
    const input = '```\n#include <stdio.h>\n# comment\n```\n\n### 后面标题';
    const out = preprocessMarkdownHeadings(input);
    expect(out).toBe('```\n#include <stdio.h>\n# comment\n```\n\n### 后面标题');
  });

  it('does not rewrite the body of an unclosed fence (mid-stream)', () => {
    const input = '```ts\nconst a = 1;\n### not a heading yet';
    expect(preprocessMarkdownHeadings(input)).toBe(input);
  });

  it('resumes rewriting after an unclosed fence is never closed', () => {
    // Nothing after the fence, so everything from the fence on stays code.
    const input = '正文### 粘连标题\n```ts\ncode';
    expect(preprocessMarkdownHeadings(input)).toBe('正文\n### 粘连标题\n```ts\ncode');
  });

  it('does not rewrite tilde-fenced code blocks', () => {
    const input = '~~~\n### keep\n~~~\n### 后面标题';
    expect(preprocessMarkdownHeadings(input)).toBe(input);
  });

  it('does not split a line on a heading marker inside an inline code span', () => {
    const input = '- 章节用 `### /` 分层';
    expect(preprocessMarkdownHeadings(input)).toBe(input);
  });

  it('does not split a line when an inline code span follows the marker text', () => {
    const input = 'Phase 计划用 `- [ ]` checkbox,章节用 `##` 与 `###` 分层';
    expect(preprocessMarkdownHeadings(input)).toBe(input);
  });

  it('still splits a real heading glued after inline code ends', () => {
    const input = '正文 `code` ### 标题';
    expect(preprocessMarkdownHeadings(input)).toBe('正文 `code` \n### 标题');
  });

  it('leaves a single hash and over-long markers untouched', () => {
    expect(preprocessMarkdownHeadings('# 单井号有空格')).toBe('# 单井号有空格');
    expect(preprocessMarkdownHeadings('####### 七个井号')).toBe('####### 七个井号');
  });
});
