/**
 * Streaming commit boundary.
 *
 * The load-bearing cases are the ones where a wrong boundary is invisible in a
 * passing test and obvious on screen: a table whose borders move on every
 * arriving row. So these assert the SHAPE of the boundary (safe vs inFlight),
 * not merely that something came back.
 *
 * Note what is NOT here: no test asserts that an unfinished code fence is
 * withheld, because it must not be. `tui-transcript-markup.test.ts` pins that
 * it stays readable, and `stream-commit.ts` records why.
 */

import { describe, it, expect } from 'vitest';
import { splitStreamCommit, growingTableStart, hasOpenFence } from '../stream-commit.js';

describe('splitStreamCommit', () => {
  describe('when nothing is being withheld', () => {
    it('passes plain prose straight through', () => {
      const commit = splitStreamCommit('first\nsecond\nthi');
      expect(commit.holding).toBe(false);
      expect(commit.safe).toBe('first\nsecond\nthi');
      expect(commit.inFlight).toBe('');
    });

    it('is empty for empty text', () => {
      expect(splitStreamCommit('')).toEqual({ safe: '', inFlight: '', holding: false });
    });

    it('does not treat a pipe in prose as a table', () => {
      const commit = splitStreamCommit('use a | b for pipes');
      expect(commit.holding).toBe(false);
      expect(commit.safe).toBe('use a | b for pipes');
    });

    it('leaves an unfinished code fence visible and unwithheld', () => {
      // Withholding this would move the content out of its frame and hide the
      // text the reader is watching. The existing renderer already marks it
      // open with `└─`.
      const commit = splitStreamCommit('```json\n{"ready": false}');
      expect(commit.holding).toBe(false);
      expect(commit.safe).toBe('```json\n{"ready": false}');
    });
  });

  describe('pipe tables', () => {
    const header = '| name | value |';
    const delimiter = '|------|-------|';

    it('withholds a table that runs to the end of what has arrived', () => {
      const commit = splitStreamCommit(`${header}\n${delimiter}\n| a | 1 |`);
      expect(commit.holding).toBe(true);
      expect(commit.safe).toBe('');
      expect(commit.inFlight).toBe(`${header}\n${delimiter}\n| a | 1 |`);
    });

    it('withholds the table but keeps the prose above it committed', () => {
      const commit = splitStreamCommit(`here:\n\n${header}\n${delimiter}`);
      expect(commit.holding).toBe(true);
      expect(commit.safe).toBe('here:\n\n');
      expect(commit.inFlight).toBe(`${header}\n${delimiter}`);
    });

    it('releases the table once a following line proves it finished', () => {
      const commit = splitStreamCommit(`${header}\n${delimiter}\n| a | 1 |\n\nafter`);
      expect(commit.holding).toBe(false);
      expect(commit.safe).toBe(`${header}\n${delimiter}\n| a | 1 |\n\nafter`);
    });

    it('treats two tables separated by a blank line as two', () => {
      const commit = splitStreamCommit(
        `${header}\n${delimiter}\n| a | 1 |\n\n${header}\n${delimiter}`,
      );
      expect(commit.holding).toBe(true);
      // The first table is released; only the second is withheld.
      expect(commit.safe).toBe(`${header}\n${delimiter}\n| a | 1 |\n\n`);
      expect(commit.inFlight).toBe(`${header}\n${delimiter}`);
    });

    it('treats two ADJACENT tables as one, matching the renderer', () => {
      // A delimiter row is indistinguishable from a data row by the run scan —
      // both just contain a pipe. `renderAssistantMarkdown` collects the same
      // way (`transcript-view.ts` renderTable call site), so holding back only
      // the "second" table would make the two disagree about where the first
      // ends. One withhold covering both is the consistent answer.
      const commit = splitStreamCommit('| a |\n|---|\n| 1 |\n| a2 |\n|---|\n| 2 |');
      expect(commit.holding).toBe(true);
      expect(commit.safe).toBe('');
      expect(commit.inFlight).toBe('| a |\n|---|\n| 1 |\n| a2 |\n|---|\n| 2 |');
    });

    it('accepts a single-column table, which a whole-line delimiter test would miss', () => {
      // `|---|` has no inner pipe, so testing the row as one /^:?-+:?$/ would
      // not find it. Cell-wise testing is what makes this work.
      const commit = splitStreamCommit('| h |\n|---|\n| 1 |');
      expect(commit.holding).toBe(true);
    });

    it('honors alignment colons in the delimiter', () => {
      const commit = splitStreamCommit('| a | b |\n|:--|--:|\n| 1 | 2 |');
      expect(commit.holding).toBe(true);
    });

    it('does not withhold a lone pipe row whose delimiter has not arrived', () => {
      // Documented boundary: the header renders as prose for a delta or two,
      // then becomes a table. Same as codex, whose holdback also triggers on
      // the header+delimiter pair. Withholding this instead would delay every
      // table's first line for no anti-reflow gain — and a paragraph turning
      // into a table happens once, where a moving border happens per row.
      const commit = splitStreamCommit('intro\n\n| name | value |\n');
      expect(commit.holding).toBe(false);
    });

    it('does not withhold a horizontal rule', () => {
      const commit = splitStreamCommit('intro\n\n---\n\nafter');
      expect(commit.holding).toBe(false);
    });
  });

  describe('line endings', () => {
    it('derives offsets from the normalized text, not the raw one', () => {
      // The bug this pins: computing the break index on the raw text and
      // slicing the normalized one is off by one per preceding CRLF.
      const commit = splitStreamCommit('a\r\nb\r\n\n| h |\r\n|---|\r\n| 1 |');
      expect(commit.safe).toBe('a\nb\n\n');
      expect(commit.inFlight).toBe('| h |\n|---|\n| 1 |');
    });

    it('handles a CRLF-only source', () => {
      expect(splitStreamCommit('a\rb').holding).toBe(false);
      expect(splitStreamCommit('a\r| h |\r|---|\r| 1 |').safe).toBe('a\n');
    });
  });

  describe('invariants', () => {
    it('never loses or duplicates content across the boundary', () => {
      const samples = [
        '',
        'plain',
        'a\nb\nc',
        'x\n\n```js\ncode\n',
        'x\n\n```js\ncode\n```\nafter',
        'p\n\n| a | b |\n|---|---|\n| 1 | 2 |',
        'p\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nq',
        'r\r\ns\r\nt',
      ];
      for (const sample of samples) {
        const commit = splitStreamCommit(sample);
        const rejoined = `${commit.safe}${commit.inFlight}`;
        expect(rejoined.replace(/\r\n?/gu, '\n')).toBe(sample.replace(/\r\n?/gu, '\n'));
      }
    });

    it('agrees with the full renderer on a released block', () => {
      // When nothing is withheld, `safe` must be the input unchanged — that is
      // what makes the finalized/streaming paths differ ONLY by the holdback.
      const sample = 'para\n\n```js\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ndone';
      expect(splitStreamCommit(sample).safe).toBe(sample);
    });
  });
});

describe('growingTableStart', () => {
  it('returns null when no table is present', () => {
    expect(growingTableStart(['plain', 'text'])).toBeNull();
  });

  it('returns the header index of a table running to the end', () => {
    expect(growingTableStart(['intro', '| a | b |', '|---|---|'])).toBe(1);
  });

  it('returns null once something follows the table', () => {
    expect(growingTableStart(['| a | b |', '|---|---|', '', 'x'])).toBeNull();
  });
});

describe('hasOpenFence', () => {
  it('detects an unclosed fence', () => {
    expect(hasOpenFence(['```js', 'body'])).toBe(true);
  });

  it('is false once the fence closes', () => {
    expect(hasOpenFence(['```js', 'body', '```'])).toBe(false);
  });

  it('lets a longer run close a shorter fence, per CommonMark', () => {
    // Same rule `renderAssistantMarkdown` applies — the two must agree or a
    // block renders differently depending on whether it has finished.
    expect(hasOpenFence(['```', 'body', '````'])).toBe(false);
  });

  it('does not let a shorter run close a longer fence', () => {
    expect(hasOpenFence(['````', 'body', '```'])).toBe(true);
  });

  it('does not let a tilde fence close a backtick fence', () => {
    expect(hasOpenFence(['```', 'body', '~~~'])).toBe(true);
  });
});