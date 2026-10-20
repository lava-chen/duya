import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  decide,
  normalizeLog,
  parseSummary,
  renderReport,
  run,
} from './test-summary-guard.mjs';

/**
 * Every fixture in `__fixtures__/` was captured from a real process, not typed
 * by hand. Provenance matters here: the whole point of the card is that the
 * old diagnosis ("the `^[[` in the log is literal text") was wrong, and a
 * hand-written sample is exactly the kind of sample that would have kept it
 * wrong. These are the bytes.
 *
 *   ci-crash-no-summary-39040547246.log
 *     Verbatim excerpt of the ubuntu `test` job of Actions run 39040547246
 *     (master `a24b14eb`), job id 117419024954, fetched with the GH API and
 *     decoded from the UTF-16LE the API serves. Actions timestamps are left
 *     in place on purpose.
 *   vitest-healthy-ansi.log
 *     Real `vitest run` output (exit 0), FORCE_COLOR=1, so the summary is
 *     wrapped in real ESC bytes.
 *   vitest-healthy-caret.log
 *     The SAME output with every `\x1b[` rewritten to the literal `^[[`. It
 *     differs from the fixture above by exactly one variable.
 *   vitest-failing-with-summary.log
 *     Real `vitest run` output (exit 1, one injected failing assertion), so the
 *     summary IS present and reads `1 failed | 1 passed`.
 */
const fixture = (name: string) =>
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
const read = (name: string) => readFileSync(fixture(name), 'latin1');
const summaryOf = (name: string) => parseSummary(normalizeLog(read(name)));
const runOn = (name: string) =>
  run(fixture(name), { summaryPath: null, stdout: () => {}, stderr: () => {} });

describe('the crash log that made CI red forever', () => {
  it('really has no vitest summary to read', () => {
    // Pin the premise. If a future regenerate produced a summary in this
    // fixture, the "unread" tests below would pass for the wrong reason.
    const log = read('ci-crash-no-summary-39040547246.log');
    expect(log).toContain('Unhandled Rejection');
    expect(log).toContain('Process completed with exit code 1');
    // vitest's summary block always says "passed". Zero occurrences means
    // there was never a summary, which is the actual root cause.
    expect(log.match(/passed/g)).toBeNull();
    expect(summaryOf('ci-crash-no-summary-39040547246.log')).toEqual({
      files: null,
      tests: null,
    });
  });

  it('reports UNKNOWN and exits neutrally, so the guard cannot fail a job it did not read', () => {
    const summary = summaryOf('ci-crash-no-summary-39040547246.log');
    const decision = decide(summary);

    // Both halves matter. "exitCode 0" alone could also mean "parsed it fine",
    // which is a different fact; "files: null" alone could be paired with a
    // red. Asserted together they say exactly one thing: not read, not fatal.
    expect(summary.files).toBeNull();
    expect(decision.verdict).toBe('unread');
    expect(decision.exitCode).toBe(0);
    expect(runOn('ci-crash-no-summary-39040547246.log')).toBe(0);
  });

  it('says in the report that UNKNOWN is about the guard, not about the suite', () => {
    const report = renderReport(
      summaryOf('ci-crash-no-summary-39040547246.log'),
      decide(summaryOf('ci-crash-no-summary-39040547246.log')),
    );
    expect(report).toContain('test files collected: **UNKNOWN**');
    expect(report).toContain('is the verdict');
    expect(report).not.toContain('guard FAILED');
  });
});

describe('a readable summary', () => {
  it('reads the totals out of real ANSI output', () => {
    expect(summaryOf('vitest-healthy-ansi.log')).toEqual({ files: 1, tests: 1 });
    expect(runOn('vitest-healthy-ansi.log')).toBe(0);
  });

  it('reads the same totals when ESC was rewritten to the literal caret form', () => {
    // The two fixtures differ by exactly one variable, so a difference in the
    // result can only be attributed to the escape spelling.
    expect(read('vitest-healthy-caret.log')).toContain('^[[2m Test Files');
    expect(summaryOf('vitest-healthy-caret.log')).toEqual(
      summaryOf('vitest-healthy-ansi.log'),
    );
  });

  it('stays neutral when tests actually failed, because vitest exit code already said so', () => {
    const summary = summaryOf('vitest-failing-with-summary.log');
    expect(summary).toEqual({ files: 1, tests: 2 });
    expect(read('vitest-failing-with-summary.log')).toContain('1 failed');
    expect(decide(summary).verdict).toBe('collected');
    // The job goes red from the test step's exit code. The guard adding a
    // second red here would be the exact duplication T04 removes.
    expect(runOn('vitest-failing-with-summary.log')).toBe(0);
  });
});

describe('the one case that is still a verdict', () => {
  it('fails a zero-collection run', () => {
    expect(decide({ files: 0, tests: 12 })).toEqual({ verdict: 'zero', exitCode: 1 });
    expect(decide({ files: 7, tests: 0 })).toEqual({ verdict: 'zero', exitCode: 1 });
  });

  it('does not confuse unreadable with empty', () => {
    expect(decide({ files: null, tests: 0 }).verdict).toBe('unread');
    expect(decide({ files: null, tests: 0 }).exitCode).toBe(0);
  });
});

describe('unreadable input stays unreadable', () => {
  it('never invents a zero from a log with no summary in it', () => {
    const summary = parseSummary(normalizeLog('hello\nnothing to see here\n'));
    expect(summary).toEqual({ files: null, tests: null });
    expect(decide(summary).exitCode).toBe(0);
  });

  it('ignores a line that merely starts with the word Tests', () => {
    const summary = parseSummary(normalizeLog('  Tests  not a summary line\n'));
    expect(summary).toEqual({ files: null, tests: null });
  });

  it('tolerates the Actions timestamp prefix', () => {
    const line = '2026-10-17T14:31:15.4308436Z \u001b[2m Tests \u001b[22m \u001b[90m (7)\u001b[39m\n';
    expect(parseSummary(normalizeLog(line))).toEqual({ files: null, tests: 7 });
  });

  it('takes the last summary block, not the first', () => {
    const log = [' Tests  1 passed (1)', ' Tests  9 passed (9)'].join('\n');
    expect(parseSummary(normalizeLog(log))).toEqual({ files: null, tests: 9 });
  });

  it('survives a UTF-16LE log from PowerShell Tee-Object', () => {
    const utf16 = Buffer.from(' Tests  3 passed (3)\n', 'utf16le');
    expect(parseSummary(normalizeLog(utf16.toString('latin1')))).toEqual({
      files: null,
      tests: 3,
    });
  });
});

describe('the CLI surface', () => {
  it('does not fail when the log file was never written', () => {
    const exitCode = run(fixture('does-not-exist.log'), {
      summaryPath: null,
      stdout: () => {},
      stderr: () => {},
    });
    expect(exitCode).toBe(0);
  });

  it('appends the report to the step summary when one is configured', () => {
    let written = '';
    run(fixture('vitest-healthy-ansi.log'), {
      summaryPath: 'memory',
      appendFileSync: (_path: string, text: string) => {
        written += text;
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(written).toContain('test files collected: **1**');
  });
});
