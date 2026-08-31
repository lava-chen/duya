import { describe, expect, it } from 'vitest';
import {
  preprocessMarkdownBold,
  preprocessBareMathExpressions,
} from './MarkdownRenderer';

describe('preprocessMarkdownBold', () => {
  it('strips whitespace inside ** markers so CommonMark recognises them', () => {
    // `** Selection **` would otherwise render literally because the spec
    // requires opening `**` to NOT be followed by whitespace. Trim the
    // captured content so the markdown parses as bold `Selection`.
    const input = '1. ** Selection **: 从根节点开始';
    const out = preprocessMarkdownBold(input);
    expect(out).toBe('1. **Selection**: 从根节点开始');
  });

  it('trims only surrounding whitespace and preserves internal spaces', () => {
    const input = '** AlphaGo Zero 的核心 **';
    expect(preprocessMarkdownBold(input)).toBe('**AlphaGo Zero 的核心**');
  });

  it('still injects ZWSP for parenthetical content', () => {
    // Existing behaviour: parenthesised bold without ZWSP fails flanking.
    const input = '**Models（模型）**';
    const out = preprocessMarkdownBold(input);
    expect(out).toBe('**\u200BModels（模型）\u200B**');
  });

  it('preserves already-tight bold with parens when no whitespace padding', () => {
    const input = '**Models**';
    expect(preprocessMarkdownBold(input)).toBe('**Models**');
  });

  it('leaves bold with internal whitespace-only content alone (already valid)', () => {
    // `**x**` is already tight, no fix needed.
    expect(preprocessMarkdownBold('a **b** c')).toBe('a **b** c');
  });

  it('handles multiple padded bolds on one line', () => {
    const input = '** Expansion ** and ** Backup **';
    expect(preprocessMarkdownBold(input)).toBe('**Expansion** and **Backup**');
  });
});

describe('preprocessBareMathExpressions', () => {
  it('wraps a math-only paragraph with greek letters and superscripts', () => {
    // The exact failure case from the canvas document: a standalone
    // equation with no `$...$` markup that the user expected KaTeX
    // to render.
    const input = 'L = (z − v)² − π·log(p) + λ‖θ‖²';
    expect(preprocessBareMathExpressions(input)).toContain('$$\nL = (z − v)² − π·log(p) + λ‖θ‖²\n$$');
  });

  it('does not wrap an argmax expression without delimiters or math symbols', () => {
    // ASCII-only expressions like `argmax( Q + U )` are technically ambiguous
    // between code and prose, so we leave them for the user to wrap in
    // `$...$` explicitly rather than guessing.
    const input = 'argmax( Q + U )';
    expect(preprocessBareMathExpressions(input)).toBe(input);
  });

  it('does not wrap ordinary prose paragraphs', () => {
    const input = '策略头（policy）：softmax → 概率分布';
    expect(preprocessBareMathExpressions(input)).toBe(input);
  });

  it('does not wrap list items or headings', () => {
    const input = [
      '# 损失函数',
      '',
      'L = (z − v)² − π·log(p) + λ‖θ‖²',
      '',
      '- 第 1 项: 价值回归误差',
    ].join('\n');
    expect(preprocessBareMathExpressions(input)).toContain('$$\nL = (z − v)²');
  });

  it('skips paragraphs that already use $ delimiters', () => {
    const input = 'already math: $x = 1$';
    expect(preprocessBareMathExpressions(input)).toBe(input);
  });

  it('skips paragraphs inside code spans', () => {
    // Backtick markers are a signal that the user wrote code, not math.
    const input = '`score = w / n + sqrt(t / n)`';
    expect(preprocessBareMathExpressions(input)).toBe(input);
  });

  it('skips fenced code blocks', () => {
    const input = '```\nL = (z − v)²\n```';
    expect(preprocessBareMathExpressions(input)).toBe(input);
  });

  it('does not wrap short equations that lack a math symbol', () => {
    // Has `=` but no Greek / operator — looks like prose such as
    // "Q = Quality" or "N = 1", so we leave it alone.
    expect(preprocessBareMathExpressions('N = 1')).toBe('N = 1');
  });

  it('does not wrap sentences ending with a period', () => {
    expect(preprocessBareMathExpressions('L = Label.')).toBe('L = Label.');
  });

  it('handles multiple paragraphs independently', () => {
    const input = [
      'L = (z − v)² − π·log(p)',
      '',
      '策略头（policy）：softmax',
      '',
      'π ∝ N^α',
    ].join('\n');
    const out = preprocessBareMathExpressions(input);
    // First and third paragraphs are math → wrapped.
    expect(out).toContain('$$\nL = (z − v)² − π·log(p)\n$$');
    expect(out).toContain('$$\nπ ∝ N^α\n$$');
    // Prose middle paragraph untouched.
    expect(out).toContain('策略头（policy）：softmax');
  });

  it('wraps a CJK-mixed paragraph when it carries enough math symbols', () => {
    // `π ∝ N^α (α=1 近似贪婪)` reads as math with a Chinese annotation,
    // not as prose. Two distinct math symbols pass the CJK filter.
    const input = 'π ∝ N^α (α=1 近似贪婪)';
    expect(preprocessBareMathExpressions(input)).toContain('$$');
  });
});
