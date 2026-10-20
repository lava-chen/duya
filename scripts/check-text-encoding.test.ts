/**
 * check-text-encoding.test.ts — regression tests for the mojibake rule.
 *
 * Context: the encoding gate only asked "does this decode as strict UTF-8,
 * BOM-less?". That question can never fail on mojibake, because mojibake is
 * byte-valid UTF-8. `packages/cli/src/chat.ts` shipped committed with ten
 * GBK-damaged em dashes (U+9225 followed by an ASCII `?`) — six of them in
 * strings printed to the user's terminal — and the gate reported the tree as
 * clean the whole time. These tests pin the rule that closes that gap, and
 * pin the false-positive boundary just as hard, because a detector that fires
 * on legitimate Chinese prose gets deleted rather than fixed.
 *
 * Every mojibake literal here is written as a \u escape. Spelling them out as
 * literal characters would plant the very bytes under test in the test file
 * itself, which the gate would then (correctly) flag.
 */
import { describe, expect, it } from 'vitest';

import { findMojibake } from './check-text-encoding.mjs';

const BAD_EM_DASH = '\u9225?'; // U+9225 followed by ASCII '?': an em dash read as GBK
const CJK_JIN_KOU = '\u9539\u65A4\u62C7'; // the UTF-8-through-GBK replacement token

describe('findMojibake', () => {
  it('reports nothing for ordinary ASCII source', () => {
    const text = 'export function write(line: string): void {\n  process.stdout.write(line);\n}\n';
    expect(findMojibake(text)).toEqual([]);
  });

  it('reports nothing for correctly encoded punctuation', () => {
    // The four em dashes that were already healthy in chat.ts.
    const text = 'session \u2014 the Host is the authority \u2014 see the docs \u2014 ok\n';
    expect(findMojibake(text)).toEqual([]);
  });

  it('detects the GBK-mojibake em dash and reports its line', () => {
    const text = 'const a = 1;\nwrite(`${DIM}' + BAD_EM_DASH + 'bye${RESET}`);\n';
    const found = findMojibake(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe('gbk-em-dash');
    expect(found[0]?.line).toBe(2);
  });

  it('detects the U+FFFD replacement character', () => {
    const found = findMojibake(`const label = 'ok\uFFFDnot ok';\n`);
    expect(found.map((f) => f.label)).toEqual(['replacement-char']);
  });

  it('detects UTF-8 bytes that were decoded as CP1252', () => {
    // The em dash, curly quote and e-acute all survive as CP1252 two-byte runs.
    expect(findMojibake('a \u00E2\u20AC" b').map((f) => f.label)).toEqual(['cp1252-punctuation']);
    expect(findMojibake('a \u00C3\u00A9 b').map((f) => f.label)).toEqual(['cp1252-letter']);
    // A UTF-8 BOM re-read as Latin-1.
    expect(findMojibake('a \u00EF\u00BF\u00BD b').map((f) => f.label)).toEqual([
      'bom-decoded-as-latin1',
    ]);
  });

  it('detects the GBK replacement token', () => {
    const found = findMojibake(`const s = '${CJK_JIN_KOU}';\n`);
    expect(found.map((f) => f.label)).toEqual(['gbk-replacement']);
  });

  it('sorts findings by line', () => {
    const text = `one '${CJK_JIN_KOU}'\ntwo ${BAD_EM_DASH}\n`;
    expect(findMojibake(text).map((f) => f.line)).toEqual([1, 2]);
  });
});

describe('findMojibake false positives', () => {
  it('does not fire on a bare CJK character that happens to be a known lead', () => {
    // U+9225 and U+9539 are both real, if obscure, Chinese characters. A
    // blacklist of bare characters would reject this legitimate line.
    const text = '// \u9225 \u9539 \u9539\u4E2D\u7684\u8BF4\u660E\n';
    expect(findMojibake(text)).toEqual([]);
  });

  it('does not fire on a question mark after any other CJK character', () => {
    // The rule is scoped to U+9225 specifically, not "any CJK then '?'".
    // Real Chinese prose does use a halfwidth question mark.
    const text = '// \u8FD9\u662F\u4EC0\u4E48? \u771F\u7684\u5417?\n';
    expect(findMojibake(text)).toEqual([]);
  });

  it('does not fire on Chinese prose, punctuation or fullwidth marks', () => {
    const text = [
      '// \u6D4B\u8BD5\u6587\u4EF6\uFF1A\u9A8C\u8BC1\u4E2D\u6587\u5185\u5BB9\u662F\u5426\u5B89\u5168\u3002',
      '// \u2014 \u201C\u5F15\u53F7\u201D\u2014 \uFF08\u53C2\u89C1\u6587\u6863\uff09',
      '',
    ].join('\n');
    expect(findMojibake(text)).toEqual([]);
  });
});

describe('findMojibake against the committed defect', () => {
  it('flags every one of the ten repaired sites in the chat.ts header and output', () => {
    // Verbatim shapes of the shipped damage, in file order.
    const damaged = [
      ' * packages/cli/src/chat.ts ' + BAD_EM_DASH + '`duya chat`: the Host-backed chat client.',
      ' * HTTP API ' + BAD_EM_DASH + 'start a run, follow its durable event stream, cancel on',
      ' * Ctrl+C ' + BAD_EM_DASH + 'exactly the same path the Desktop uses.',
      '      write(`${DIM}' + BAD_EM_DASH + '${payload.message}${RESET}`);',
      '    write(`${RED}run refused: ${start.stage} ' + BAD_EM_DASH + '${start.reason}${RESET}`);',
      '  write(`${DIM}session ${sessionId} ' + BAD_EM_DASH + 'type a message${RESET}`);',
      '    prompt: `${BRIGHT_CYAN}you${RESET} ${DIM}' + BAD_EM_DASH + '{RESET} `,',
      '            write(`${RED}run refused: ${start.stage} ' + BAD_EM_DASH + '${start.reason}${RESET}`);',
      '  write(`${DIM}goodbye ' + BAD_EM_DASH + 'session ${sessionId}${RESET}`);',
      '  // NOT patched ' + BAD_EM_DASH + 'that is what blessed draws.',
    ];
    for (const line of damaged) {
      const found = findMojibake(`${line}\n`);
      expect(found, `expected a finding in: ${line}`).toHaveLength(1);
      expect(found[0]?.label).toBe('gbk-em-dash');
    }
  });

  it('finds nothing in the repaired file shape', () => {
    // The same ten lines after replacement with a real em dash.
    const repaired = [
      ' * packages/cli/src/chat.ts \u2014`duya chat`: the Host-backed chat client.',
      '    prompt: `${BRIGHT_CYAN}you${RESET} ${DIM}\u2014${RESET} `,',
      '  write(`${DIM}goodbye \u2014session ${sessionId}${RESET}`);',
    ].join('\n');
    expect(findMojibake(repaired)).toEqual([]);
  });
});
