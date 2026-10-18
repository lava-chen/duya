/**
 * Render-parity harness: replay two renderers' terminal bytes into glyph grids.
 *
 * ## Why a replay rather than a string compare
 *
 * `BlessedScreenSurface` diff-renders through cursor addressing; `OwnScreenSurface`
 * rewrites whole rows. The same final screen reaches the wire as two completely
 * different byte streams, so equality has to be decided on the SCREEN the bytes
 * describe, not on the bytes. This file is that screen: a minimal VT toy that
 * understands exactly the vocabulary the two renderers use and nothing else.
 *
 * Deliberately NOT a general terminal emulator: anything the renderers do not
 * emit is a bug in this file, not a feature to add.
 */

import { codePointWidth } from '../width.js';

export const SCREEN_COLUMNS = 80;
export const SCREEN_ROWS = 24;

/** One screen cell. Empty string marks the continuation half of a wide glyph. */
export type Grid = string[][];

export function blankGrid(): Grid {
  return Array.from({ length: SCREEN_ROWS }, () =>
    Array.from({ length: SCREEN_COLUMNS }, () => ' '),
  );
}

function saveGrid(grid: Grid): { cursor: { row: number; column: number }; cells: Grid } {
  return {
    cursor: { row: cursor.row, column: cursor.column },
    cells: grid.map((row) => [...row]),
  };
}

let cursor = { row: 0, column: 0 };

/**
 * DEC Special Graphics (the ACS vocabulary blessed draws borders with). A real
 * terminal renders `ESC(0 q` as exactly the same glyph as own renderer's
 * literal `─`, so the replay has to decode it or every border is a false red.
 */
const ACS: Readonly<Record<string, string>> = {
  '`': '◆', a: '▒', f: '°', g: '±', h: '␤', i: '␋',
  j: '┘', k: '┐', l: '┌', m: '└', n: '┼', o: '⎺', p: '⎻',
  q: '─', r: '⎼', s: '⎽', t: '├', u: '┤', v: '┴', w: '┬',
  x: '│', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
  '0': '█', '1': '▘', '2': '▝', '3': '▖', '4': '▗',
  '5': '▚', '6': '▞', '7': '▌', '8': '▐', '9': '▍',
};

/**
 * Replay a byte stream into a glyph grid.
 *
 * Semantics notes:
 * - `\n` moves down AND to column 0. The renderers are written against a
 *   terminal with ONLCR, where the driver supplies the carriage return.
 * - SGR, mode set/reset, OSC and unknown CSI are consumed, never drawn.
 */
export function replay(bytes: string): Grid {
  const grid = blankGrid();
  const saved: { cursor: { row: number; column: number }; cells: Grid }[] = [];
  cursor = { row: 0, column: 0 };
  let index = 0;
  let acs = false;

  const clamp = (): void => {
    cursor.row = Math.min(SCREEN_ROWS - 1, Math.max(0, cursor.row));
    cursor.column = Math.min(SCREEN_COLUMNS - 1, Math.max(0, cursor.column));
  };

  const putGlyph = (glyph: string): void => {
    const width = Math.max(1, codePointWidth(glyph));
    if (glyph === '\n') {
      cursor.row += 1;
      cursor.column = 0;
      clamp();
      return;
    }
    if (cursor.row < 0 || cursor.row >= SCREEN_ROWS) {
      cursor.row = SCREEN_ROWS - 1;
    }
    if (cursor.column + width > SCREEN_COLUMNS) {
      // Real terminals wrap; neither renderer relies on it. Park at the edge.
      cursor.column = SCREEN_COLUMNS - width;
      if (cursor.column < 0) return;
    }
    grid[cursor.row][cursor.column] = glyph;
    for (let offset = 1; offset < width; offset += 1) {
      if (cursor.column + offset < SCREEN_COLUMNS) grid[cursor.row][cursor.column + offset] = '';
    }
    cursor.column += width;
    clamp();
  };

  while (index < bytes.length) {
    const char = bytes[index] as string;

    if (char !== '\x1b') {
      if (char === '\r') {
        cursor.column = 0;
        index += 1;
        continue;
      }
      if (char === '\b') {
        cursor.column = Math.max(0, cursor.column - 1);
        index += 1;
        continue;
      }
      if (char === '\t') {
        putGlyph(' ');
        index += 1;
        continue;
      }
      if (char === '\x07' || char === '\x00') {
        index += 1;
        continue;
      }
      // Grapheme clusters: keep combining marks attached to their base cell.
      if (/[\u0300-\u036f\u200d\ufe0f]/u.test(char) === true && cursor.column > 0) {
        grid[cursor.row][Math.max(0, cursor.column - 1)] += char;
        index += 1;
        continue;
      }
      putGlyph(acs ? (ACS[char] ?? char) : char);
      index += 1;
      continue;
    }

    const rest = bytes.slice(index);
    const csi = /^(\x1b\[)([0-9;?<>= ]*)([A-Za-z@`^_~])/.exec(rest);
    if (csi !== null) {
      const parameters = csi[2] ?? '';
      const final = csi[3] ?? '';
      const numbers = parameters.replace(/[?<>= ]/g, '').split(';').map((part) =>
        part === '' ? NaN : Number.parseInt(part, 10),
      );
      const value = (position: number, fallback: number): number => {
        const raw = numbers[position];
        return raw === undefined || Number.isNaN(raw) ? fallback : raw;
      };
      switch (final) {
        case 'H':
        case 'f':
          cursor.row = value(0, 1) - 1;
          cursor.column = value(1, 1) - 1;
          clamp();
          break;
        case 'd':
          cursor.row = value(0, 1) - 1;
          clamp();
          break;
        case 'G':
        case '`':
          cursor.column = value(0, 1) - 1;
          clamp();
          break;
        case 'A':
          cursor.row -= value(0, 1);
          clamp();
          break;
        case 'B':
        case 'e':
          cursor.row += value(0, 1);
          clamp();
          break;
        case 'C':
        case 'a':
          cursor.column += value(0, 1);
          clamp();
          break;
        case 'D':
          cursor.column -= value(0, 1);
          clamp();
          break;
        case 'E':
          cursor.row += value(0, 1);
          cursor.column = 0;
          clamp();
          break;
        case 'F':
          cursor.row -= value(0, 1);
          cursor.column = 0;
          clamp();
          break;
        case 'K': {
          const mode = value(0, 0);
          const row = grid[cursor.row];
          if (row !== undefined) {
            if (mode === 0) for (let x = cursor.column; x < SCREEN_COLUMNS; x += 1) row[x] = ' ';
            else if (mode === 1) for (let x = 0; x <= cursor.column; x += 1) row[x] = ' ';
            else for (let x = 0; x < SCREEN_COLUMNS; x += 1) row[x] = ' ';
          }
          break;
        }
        case 'J': {
          const mode = value(0, 0);
          if (mode === 2 || mode === 3) {
            for (const row of grid) row.fill(' ');
          } else if (mode === 0) {
            const row = grid[cursor.row];
            if (row !== undefined) for (let x = cursor.column; x < SCREEN_COLUMNS; x += 1) row[x] = ' ';
            for (let y = cursor.row + 1; y < SCREEN_ROWS; y += 1) grid[y]?.fill(' ');
          } else {
            for (let y = 0; y < cursor.row; y += 1) grid[y]?.fill(' ');
            const row = grid[cursor.row];
            if (row !== undefined) for (let x = 0; x <= cursor.column; x += 1) row[x] = ' ';
          }
          break;
        }
        case 'X': {
          const count = value(0, 1);
          const row = grid[cursor.row];
          if (row !== undefined) {
            for (let x = cursor.column; x < Math.min(SCREEN_COLUMNS, cursor.column + count); x += 1) {
              row[x] = ' ';
            }
          }
          break;
        }
        case 'M':
          cursor.row = Math.max(0, cursor.row - 1);
          break;
        case 'L':
        case 'P':
        case '@':
        case 'S':
        case 'T':
          // Insert/delete affect scrollback placement, not final glyphs.
          break;
        default:
          break;
      }
      index += csi[0].length;
      continue;
    }

    // OSC: terminated by BEL or ST (ESC \).
    if (rest.startsWith('\x1b]')) {
      const bel = rest.indexOf('\x07');
      const st = rest.indexOf('\x1b\\');
      if (bel !== -1 && (st === -1 || bel < st)) {
        index += bel + 1;
      } else if (st !== -1) {
        index += st + 2;
      } else {
        break;
      }
      continue;
    }

    // ESC 7 / ESC 8: save and restore cursor.
    if (rest.startsWith('\x1b7')) {
      saved.push(saveGrid(grid));
      index += 2;
      continue;
    }
    if (rest.startsWith('\x1b8')) {
      const restore = saved.pop();
      if (restore !== undefined) {
        cursor = { ...restore.cursor };
      }
      index += 2;
      continue;
    }
    if (rest.startsWith('\x1bM')) {
      cursor.row = Math.max(0, cursor.row - 1);
      index += 2;
      continue;
    }
    if (rest.startsWith('\x1b(B') || rest.startsWith('\x1b)B')) {
      acs = false;
      index += 3;
      continue;
    }
    // Charset selection: ESC(0 enters DEC Special Graphics, ESC(B leaves it.
    if (rest.startsWith('\x1b(0')) {
      acs = true;
      index += 3;
      continue;
    }
    if (rest.startsWith('\x1b(') || rest.startsWith('\x1b)')) {
      acs = false;
      index += 3;
      continue;
    }

    // Unknown escape: drop the ESC and keep scanning so a vocabulary gap can
    // never silently swallow the rest of the frame.
    index += 1;
  }

  return grid;
}

/** Render both grids as an annotated diff for the failure message. */
export function gridDiff(blessed: Grid, own: Grid): string {
  const lines: string[] = [];
  for (let y = 0; y < SCREEN_ROWS; y += 1) {
    const left = blessed[y] ?? [];
    const right = own[y] ?? [];
    const same = left.every((cell, x) => (right[x] ?? ' ') === cell);
    if (same) continue;
    let caret = '';
    for (let x = 0; x < SCREEN_COLUMNS; x += 1) {
      caret += (right[x] ?? ' ') === (left[x] ?? ' ') ? ' ' : '^';
    }
    lines.push(`row ${y}: blessed=${JSON.stringify(left.join('').replace(/\u0000/g, ''))}`);
    lines.push(`        own    =${JSON.stringify(right.join('').replace(/\u0000/g, ''))}`);
    lines.push(`        diff   =${caret}`);
  }
  return lines.join('\n');
}
