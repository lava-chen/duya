/**
 * Bash command highlighting — the colour a shell command carries in the
 * transcript.
 *
 * ## Why a command needs colour at all
 *
 * A tool cell used to paint the command and its output in the same muted grey,
 * so `git log --oneline -3` and the three commits under it read as one grey
 * block and the reader had to parse the line to find the command. The
 * reference UIs do not do that: codex renders a command through a real bash
 * grammar and lets the program, its flags and its quoting carry different
 * colours, so the eye picks the command out of the output without reading it.
 *
 * This module is that grammar, restricted to what a command line actually
 * needs: no reflection, no strings-inside-strings, no heredocs. It answers one
 * question per run of characters — what KIND of thing is this — and leaves the
 * colour to the caller, because the palette belongs to the theme and the
 * grammar does not.
 *
 * ## Roles, not colours
 *
 * `program` is not "cyan": it is "the thing being run". The renderer maps a
 * role to a theme token, so the light and dark palettes both stay correct and
 * a future theme only has to answer the same seven questions.
 *
 * ## What it deliberately does not do
 *
 * The tokenizer is a single pass with no backtracking and no lookahead beyond
 * one character, so a half-typed command (which is what the transcript shows
 * while a call is streaming) highlights as well as a complete one. It is not a
 * shell parser and must not become one: a wrong colour is cosmetic, while a
 * tokenizer that can throw on an unbalanced quote would break the transcript.
 */

/** What a run of characters is, in shell terms. */
export type BashRole =
  /** The thing being run: `git`, `npm`, `rg`. */
  | 'program'
  /** An option: `-la`, `--oneline`. */
  | 'flag'
  /** A quoted run, with its quotes: `'a b'`, `"x"`. */
  | 'string'
  /** A shell control character: `|`, `&&`, `;`, `>`. */
  | 'operator'
  /** A parameter expansion: `$HOME`, `${x}`, `$(date)`. */
  | 'variable'
  /** A `# …` comment. */
  | 'comment'
  /** Everything else: paths, arguments, keywords, whitespace. */
  | 'plain';

/** One run of characters and the role it plays. */
export interface BashToken {
  readonly text: string;
  readonly role: BashRole;
}

/** Characters that end a word and carry shell meaning on their own. */
const OPERATOR_CHARS = new Set(['|', '&', ';', '<', '>', '(', ')']);

/**
 * Words that introduce ANOTHER command rather than being the command.
 *
 * `sudo git status` is one command whose program is `git`; colouring `sudo` as
 * the program would point the eye at the wrong word. The list is the common
 * prefixes, not the POSIX reserved-word list — a command nobody writes is not
 * worth a special case that can be wrong.
 */
const PREFIX_WORDS = new Set([
  'sudo',
  'doas',
  'time',
  'nice',
  'nohup',
  'env',
  'command',
  'builtin',
  'exec',
  'xargs',
  'then',
  'do',
  'else',
]);

/** Punctuation that leaves the next word in command position. */
function startsNewCommand(operator: string): boolean {
  return operator.includes('|') || operator.includes(';') || operator === '&&' || operator === '&';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/**
 * Whether a redirect starts here with its descriptor: `2>`, `2>&1`, `0<`.
 *
 * Without this the digit is read as the start of a word and `2>&1` tokenizes
 * as the argument `2`, then `>&1` — the operator still colours, but the `2`
 * reads as an argument to the command, which it is not.
 */
function startsNumericRedirect(line: string, start: number): boolean {
  let index = start;
  while (index < line.length && isDigit(line[index] as string)) index += 1;
  return index > start && (line[index] === '>' || line[index] === '<');
}

/**
 * Highlight one line of a shell command.
 *
 * Never throws and never returns an empty array for a non-empty line: every
 * character lands in exactly one token, so the concatenated text is always the
 * input. That invariant is what lets the renderer paint the result without
 * re-checking whether anything was dropped.
 */
export function highlightBashLine(line: string): BashToken[] {
  const tokens: BashToken[] = [];
  const push = (text: string, role: BashRole): void => {
    if (text === '') return;
    const last = tokens[tokens.length - 1];
    // Coalesce runs of the same role: a path with three slashes is one token,
    // not four, which keeps the span list (and every test over it) readable.
    if (last !== undefined && last.role === role) {
      tokens[tokens.length - 1] = { text: last.text + text, role };
      return;
    }
    tokens.push({ text, role });
  };

  /** True while the next word would be the command itself. */
  let commandPosition = true;
  let index = 0;

  while (index < line.length) {
    const char = line[index] as string;

    if (char === ' ' || char === '\t') {
      const start = index;
      while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index += 1;
      push(line.slice(start, index), 'plain');
      continue;
    }

    if (char === '#') {
      push(line.slice(index), 'comment');
      break;
    }

    if (char === '"' || char === "'") {
      const end = endOfQuoted(line, index);
      push(line.slice(index, end), 'string');
      index = end;
      commandPosition = false;
      continue;
    }

    if (char === '$') {
      const end = endOfExpansion(line, index);
      push(line.slice(index, end), 'variable');
      index = end;
      // `$CMD arg` runs the expansion, so the next word is still an argument.
      commandPosition = false;
      continue;
    }

    if (OPERATOR_CHARS.has(char) || startsNumericRedirect(line, index)) {
      const start = index;
      // A file-descriptor redirect opens with its descriptor (`2>&1`).
      while (index < line.length && isDigit(line[index] as string)) index += 1;
      const operatorStart = index;
      while (index < line.length && OPERATOR_CHARS.has(line[index] as string)) index += 1;
      // `>&1` / `&>`: the ampersand and its descriptor belong to the redirect.
      while (index < line.length && (isDigit(line[index] as string) || line[index] === '&')) index += 1;
      const operator = line.slice(start, index);
      push(operator, 'operator');
      commandPosition = startsNewCommand(line.slice(operatorStart, index));
      continue;
    }

    const start = index;
    while (index < line.length) {
      const next = line[index] as string;
      if (next === ' ' || next === '\t' || next === '$' || next === '"' || next === "'") break;
      if (OPERATOR_CHARS.has(next) || next === '#') break;
      index += 1;
    }
    // A word made only of characters the loop above rejects would spin.
    if (index === start) {
      push(char, 'plain');
      index += 1;
      continue;
    }
    const word = line.slice(start, index);
    if (word.startsWith('-') && word !== '-') {
      push(word, 'flag');
      continue;
    }
    // `FOO=1 cmd`: an assignment in command position is not the command.
    if (commandPosition && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
      push(word, 'plain');
      continue;
    }
    if (commandPosition) {
      // A prefix word introduces the command without being it, so the next
      // word keeps command position.
      if (PREFIX_WORDS.has(word)) {
        push(word, 'plain');
        continue;
      }
      push(word, 'program');
      commandPosition = false;
      continue;
    }
    push(word, 'plain');
  }

  return tokens;
}

/** Every line of a command, highlighted. A command may be multi-line. */
export function highlightBash(command: string): BashToken[][] {
  return command.split('\n').map((line) => highlightBashLine(line));
}

/** Index just past the closing quote, or the end of the line when unclosed. */
function endOfQuoted(line: string, start: number): number {
  const quote = line[start] as string;
  let index = start + 1;
  while (index < line.length) {
    const char = line[index] as string;
    if (char === '\\' && quote === '"') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return line.length;
}

/** Index just past a `$…` expansion, or the end of the line when unclosed. */
function endOfExpansion(line: string, start: number): number {
  const next = line[start + 1];
  if (next === '(') {
    // `$(…)`: stop at the matching paren, so a subshell stays one token.
    let depth = 1;
    let index = start + 2;
    while (index < line.length && depth > 0) {
      const char = line[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    return index;
  }
  if (next === '{') {
    let index = start + 2;
    while (index < line.length && line[index] !== '}') index += 1;
    return Math.min(line.length, index + 1);
  }
  if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/u.test(next)) {
    let index = start + 1;
    while (index < line.length && /[A-Za-z0-9_]/u.test(line[index] as string)) index += 1;
    return index;
  }
  // A lone `$` is just a character (`$` in a regex, a prompt sigil).
  return start + 1;
}
