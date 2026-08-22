// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from './message-input-logic';

describe('htmlToPlainText', () => {
  it('returns empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });

  it('strips inline color and bold styling from pasted markup', () => {
    const html = '<span style="color:red">红色文字</span> <b>粗体</b>';
    expect(htmlToPlainText(html)).toBe('红色文字 粗体');
  });

  // Regression guard for the paste-formatting complaint: the classic Word /
  // WPS clipboard payload carries spans with color/weight and must reduce
  // to its text content only.
  it('reduces a word-processor style fragment to plain lines', () => {
    const html =
      '<div><span style="color:#ff0000;font-weight:bold">重要结论</span></div>' +
      '<div>普通段落，含 <strong>加粗</strong> 与 <em>斜体</em></div>';
    const result = htmlToPlainText(html);
    expect(result).not.toMatch(/color|span|strong/i);
    expect(result).toContain('重要结论');
    expect(result).toContain('加粗');
    expect(result).toContain('斜体');
  });

  it('converts <br> to newlines', () => {
    expect(htmlToPlainText('line1<br>line2<br/>line3')).toBe('line1\nline2\nline3');
  });

  it('keeps paragraph boundaries as newlines without triple blank runs', () => {
    const html = '<p>one</p><p>two</p><div><p>nested</p></div>';
    expect(htmlToPlainText(html)).toBe('one\ntwo\nnested');
  });

  it('renders list items on separate lines', () => {
    const html = '<ul><li>alpha</li><li>beta</li></ul>';
    const result = htmlToPlainText(html);
    expect(result).toContain('alpha');
    expect(result).toContain('beta');
    expect(result.indexOf('alpha')).toBeLessThan(result.indexOf('beta'));
  });
});
