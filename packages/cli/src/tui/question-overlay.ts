/**
 * The ask-user-question overlay: codex `bottom_pane/request_user_input`, adapted.
 *
 * ## Why a dedicated state machine
 *
 * An `ask_user_question` permission request is not an approval — the generic
 * Allow/Deny picker is meaningless against "which auth approach?". This state
 * machine owns the question loop instead: option cursor, a one-line notes
 * buffer per question, a focus that TYPING silently captures (the codex trick
 * that keeps freeform input one keystroke away), and the unanswered-question
 * confirmation before submit.
 *
 * ## Answer contract
 *
 * The answers are a `Record<questionText, string>` keyed by the question text
 * — the same shape `AskUserQuestionTool`'s Phase 2 reads from
 * `pendingAnswers` (see `formatAnswersForLLM`: `"Q"="A"` pairs). A selected
 * option contributes its label; notes ride inside the answer as
 * `label (notes)`; a freeform-only answer is the notes text; an unanswered
 * question simply has no key. Multi-select joins labels with ", ".
 *
 * ## Selection semantics
 *
 * Navigating the cursor is NEVER a selection, and Enter carries two meanings
 * split by focus: on the option list it accepts the highlighted row; in notes
 * it does not (so a note typed from scratch stays a freeform answer instead of
 * silently gaining the highlighted option). The synthetic "None of the above"
 * row is excluded from that acceptance on purpose — committing on it is how a
 * user deliberately leaves a question blank, which is the only way the
 * unanswered-confirmation panel is ever reached.
 */

import { escapeTags } from './transcript-view.js';

/** One choice inside a question. */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

/** One question, as parsed from the tool input. */
export interface ParsedQuestion {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
}

/** The synthetic last option, codex `OTHER_OPTION_LABEL`. */
export const NONE_OF_THE_ABOVE: QuestionOption = {
  label: 'None of the above',
  description: 'Optionally, add details in notes (tab).',
};

/** Maximum options before the list would need scrolling — the schema caps at 4. */
const MAX_OPTIONS = 4;

/**
 * Parse the tool input into questions, tolerating the loose shapes the wire
 * can carry (options as a JSON string, missing multiSelect). Returns `null`
 * when nothing usable is there, so the caller can fall back to the generic
 * picker rather than showing a broken questionnaire.
 */
export function parseQuestionInput(toolInput: unknown): ParsedQuestion[] | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const raw = (toolInput as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const questions: ParsedQuestion[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const q = entry as Record<string, unknown>;
    if (typeof q.question !== 'string' || q.question === '') return null;
    let optionsRaw: unknown = q.options;
    if (typeof optionsRaw === 'string') {
      try {
        optionsRaw = JSON.parse(optionsRaw);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(optionsRaw) || optionsRaw.length < 2 || optionsRaw.length > MAX_OPTIONS) return null;
    const options: QuestionOption[] = [];
    for (const opt of optionsRaw) {
      if (typeof opt !== 'object' || opt === null) return null;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== 'string' || o.label === '') return null;
      options.push({
        label: o.label,
        description: typeof o.description === 'string' && o.description !== '' ? o.description : undefined,
      });
    }
    questions.push({
      question: q.question,
      header: typeof q.header === 'string' && q.header !== '' ? q.header : undefined,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return questions;
}

/** Every option row of a question, including the synthetic tail. */
export function questionRows(question: ParsedQuestion): readonly QuestionOption[] {
  return [...question.options, NONE_OF_THE_ABOVE];
}

/**
 * The per-question answer, or `undefined` when the question went unanswered.
 *
 * Selected labels join with ", "; notes append as ` (notes)`; notes alone
 * (nothing selected) are a freeform answer.
 */
export function buildAnswer(
  question: ParsedQuestion,
  selected: ReadonlySet<number>,
  notes: string,
): string | undefined {
  const rows = questionRows(question);
  const labels: string[] = [];
  for (const index of selected) {
    const row = rows[index];
    if (row !== undefined) labels.push(row.label);
  }
  const trimmed = notes.trim();
  if (labels.length === 0) return trimmed === '' ? undefined : trimmed;
  const joined = labels.join(', ');
  return trimmed === '' ? joined : `${joined} (${trimmed})`;
}

/** What the renderer needs beyond the state itself. */
export interface QuestionOverlayView {
  readonly queueDepth: number;
}

type Focus = 'options' | 'notes';

/** Result of finishing the questionnaire. */
export type QuestionOutcome =
  | { readonly action: 'submit'; readonly answers: Record<string, string> }
  | { readonly action: 'cancel' };

/**
 * The question loop for one request.
 *
 * Only ever driven by `OverlayState` delegation — one questionnaire is
 * interactive at a time, exactly like the permission picker's head.
 */
export class QuestionAskState {
  private readonly questions: readonly ParsedQuestion[];
  private index = 0;
  private cursor = 0;
  private readonly selections = new Map<number, Set<number>>();
  private readonly notes = new Map<number, string>();
  private focus: Focus = 'options';
  private confirming = false;
  private confirmIndex = 0;
  /**
   * Set ONLY by an explicit commit action (Enter, a quick-pick digit, the
   * confirm panel's Proceed). Navigation must not submit — on an
   * already-fully-answered single question every key would otherwise look like
   * a submit.
   */
  private finished = false;

  constructor(questions: readonly ParsedQuestion[]) {
    this.questions = questions;
  }

  /** Zero-based index of the question on screen. */
  get currentIndex(): number {
    return this.index;
  }

  /** True while the unanswered-confirmation panel is up. */
  get isConfirming(): boolean {
    return this.confirming;
  }

  /** Questions that would submit without an answer. */
  get unansweredCount(): number {
    let count = 0;
    for (let i = 0; i < this.questions.length; i += 1) {
      if (!this.hasAnswer(i)) count += 1;
    }
    return count;
  }

  private hasAnswer(index: number): boolean {
    return buildAnswer(
      this.questions[index] as ParsedQuestion,
      this.selections.get(index) ?? new Set<number>(),
      this.notes.get(index) ?? '',
    ) !== undefined;
  }

  /**
   * One key against the questionnaire.
   *
   * A printable character means "I want to type" — the focus jumps into notes
   * and the character lands there (codex's fast-freeform rule). Option-list
   * keys apply only while the option cursor has focus, so a digit or a space
   * typed into a note stays literal text. Everything unrecognised is reported
   * so the caller can keep swallowing it.
   */
  handleKey(input: { readonly name?: string; readonly ch?: string }): boolean {
    if (this.confirming) return this.handleConfirmKey(input);
    const name = input.name ?? '';

    if (name === 'escape') return false; // OverlayState owns cancel.
    if (name === 'tab') {
      this.focus = this.focus === 'options' ? 'notes' : 'options';
      return true;
    }
    // Enter commits from EITHER focus: the notes buffer is single-line, so
    // Enter is unambiguous and is how a note-only answer is submitted.
    if (name === 'return' || name === 'enter') return this.commit();
    if (name === 'backspace') {
      if (this.focus !== 'notes') return false;
      const current = this.notes.get(this.index) ?? '';
      this.notes.set(this.index, current.slice(0, -1));
      return true;
    }

    if (this.focus === 'options') {
      // Arrows only. `j`/`k` are NOT navigation here, unlike the picker: the
      // notes buffer is a real text field, and binding them would make a note
      // that starts with "j" impossible.
      if (name === 'up') return this.moveCursor(-1);
      if (name === 'down') return this.moveCursor(1);
      if (name === 'space') return this.toggleMulti();
      // Quick-pick: a digit accepts that option row in one keystroke.
      const digit = /^([1-9])$/.exec(name !== '' ? name : input.ch ?? '');
      if (digit !== null) {
        const target = Number(digit[1]) - 1;
        const rows = questionRows(this.questions[this.index] as ParsedQuestion);
        if (target >= rows.length) return false;
        this.cursor = target;
        if (this.questions[this.index]?.multiSelect === true) return this.toggleMulti();
        return this.commit();
      }
    }

    // Any other printable character becomes notes content, and focusing it.
    const ch = input.ch ?? '';
    if (ch.length === 1 && ch >= ' ' && ch !== '\u007f') {
      this.focus = 'notes';
      this.notes.set(this.index, (this.notes.get(this.index) ?? '') + ch);
      return true;
    }
    return false;
  }

  private handleConfirmKey(input: { readonly name?: string; readonly ch?: string }): boolean {
    const name = input.name ?? '';
    if (name === 'up' || name === 'k' || name === 'left') {
      this.confirmIndex = 0;
      return true;
    }
    if (name === 'down' || name === 'j' || name === 'right') {
      this.confirmIndex = 1;
      return true;
    }
    if (name === 'escape') {
      this.confirming = false;
      return true;
    }
    if (name === 'return' || name === 'enter' || name === 'y' || name === 'n') {
      if (this.confirmIndex === 0) {
        this.confirming = false;
        this.focusUnanswered();
        return true;
      }
      this.finished = true;
      return true;
    }
    return false;
  }

  private moveCursor(delta: number): boolean {
    const rows = questionRows(this.questions[this.index] as ParsedQuestion);
    this.cursor = (this.cursor + delta + rows.length) % rows.length;
    return true;
  }

  private toggleMulti(): boolean {
    const question = this.questions[this.index];
    if (question === undefined || question.multiSelect !== true) return false;
    const set = this.selections.get(this.index) ?? new Set<number>();
    if (set.has(this.cursor)) set.delete(this.cursor);
    else set.add(this.cursor);
    this.selections.set(this.index, set);
    return true;
  }

  /**
   * Commit the current question and advance.
   *
   * Enter accepts the highlighted row first (see `recordHighlightedPick`), then
   * either advances or submits. A question with neither a selection nor notes
   * advances unanswered rather than blocking — the confirmation panel catches
   * it before submit.
   */
  private commit(): boolean {
    this.recordHighlightedPick();
    if (this.index < this.questions.length - 1) {
      this.index += 1;
      this.cursor = 0;
      this.focus = 'options';
      return true;
    }
    if (this.unansweredCount > 0) {
      this.confirming = true;
      this.confirmIndex = 0;
      return true;
    }
    this.finished = true;
    return true;
  }

  /**
   * Enter's "accept the highlighted row" meaning.
   *
   * The synthetic "None of the above" tail is excluded: its whole point is to
   * move on WITHOUT answering. Notes focus is excluded too, so typing a
   * freeform answer does not silently gain the highlighted option. An existing
   * selection is never overwritten.
   */
  private recordHighlightedPick(): void {
    if (this.focus !== 'options') return;
    if ((this.selections.get(this.index)?.size ?? 0) > 0) return;
    const question = this.questions[this.index] as ParsedQuestion;
    if (this.cursor >= question.options.length) return; // synthetic tail
    this.selections.set(this.index, new Set([this.cursor]));
  }

  /** True when the questionnaire is ready to submit on the current key. */
  get readyToSubmit(): boolean {
    return this.finished;
  }

  /** The submit result, valid only when `readyToSubmit` holds. */
  finish(): QuestionOutcome {
    if (!this.readyToSubmit) return { action: 'cancel' };
    const answers: Record<string, string> = {};
    for (let i = 0; i < this.questions.length; i += 1) {
      const question = this.questions[i] as ParsedQuestion;
      const answer = buildAnswer(question, this.selections.get(i) ?? new Set<number>(), this.notes.get(i) ?? '');
      if (answer !== undefined) answers[question.question] = answer;
    }
    return { action: 'submit', answers };
  }

  /** Jump to the first question without an answer (the Go-back action). */
  private focusUnanswered(): void {
    for (let i = 0; i < this.questions.length; i += 1) {
      if (!this.hasAnswer(i)) {
        this.index = i;
        this.cursor = 0;
        this.focus = 'options';
        return;
      }
    }
  }

  /** The overlay body, as blessed tags — codex `render_ui_at`, flattened. */
  render(view: QuestionOverlayView = { queueDepth: 0 }): string {
    if (this.confirming) return this.renderConfirm();
    const lines: string[] = [];
    const question = this.questions[this.index] as ParsedQuestion;
    const answered = this.questions.filter((_, i) => this.hasAnswer(i)).length;

    lines.push(`{gray-fg}Question ${this.index + 1}/${this.questions.length}${answered > 0 ? ` · ${answered} answered` : ''}{/gray-fg}`);
    // Model-authored text: escaped, never trusted as Blessed markup (a question
    // quoting `{...}` would otherwise paint the rest of the overlay).
    const questionText = escapeTags(question.question);
    if (question.header !== undefined) {
      lines.push(`{bold}{cyan-fg}[${escapeTags(question.header)}]{/cyan-fg}{/bold} {cyan-fg}${questionText}{/cyan-fg}`);
    } else {
      lines.push(`{cyan-fg}${questionText}{/cyan-fg}`);
    }
    lines.push('');

    const rows = questionRows(question);
    const selected = this.selections.get(this.index) ?? new Set<number>();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] as QuestionOption;
      const isCursor = this.focus === 'options' && i === this.cursor;
      const marker = isCursor ? '{cyan-fg}❯{/cyan-fg} ' : '  ';
      const isSynthetic = i >= question.options.length;
      const check = question.multiSelect && selected.has(i) ? '{green-fg}✓{/green-fg} ' : '';
      const labelText = escapeTags(`${i + 1}. ${row.label}`);
      const label = isSynthetic
        ? `{gray-fg}${labelText}{/gray-fg}`
        : isCursor ? `{cyan-fg}${labelText}{/cyan-fg}` : labelText;
      lines.push(`${marker}${check}${label}`);
      if (row.description !== undefined) {
        lines.push(`     {gray-fg}${escapeTags(row.description)}{/gray-fg}`);
      }
    }

    const noteText = this.notes.get(this.index) ?? '';
    if (this.focus === 'notes' || noteText !== '') {
      lines.push('');
      lines.push(`{cyan-fg}┃{/cyan-fg} ${escapeTags(noteText)}{gray-fg}_  (notes — Enter commits){/gray-fg}`);
    }

    if (question.multiSelect) {
      lines.push('');
      lines.push('{gray-fg}multi-select — space toggles{/gray-fg}');
    }
    const waiting = view.queueDepth > 0 ? ` · +${view.queueDepth} waiting` : '';
    lines.push(`{gray-fg}↑/↓ choose · 1-${rows.length} quick-pick${question.multiSelect ? ' · space multi' : ''} · tab notes · Enter ${this.index === this.questions.length - 1 ? 'submit' : 'next'} · Esc cancel${waiting}{/gray-fg}`);
    return lines.join('\n');
  }

  private renderConfirm(): string {
    const lines: string[] = [];
    const count = this.unansweredCount;
    lines.push('{bold}Submit with unanswered questions?{/bold}');
    lines.push(`{gray-fg}${count} question${count === 1 ? '' : 's'} would submit without an answer.{/gray-fg}`);
    lines.push('');
    lines.push(`${this.confirmIndex === 0 ? '{cyan-fg}❯{/cyan-fg} ' : '  '}Go back — return to the first unanswered question`);
    lines.push(`${this.confirmIndex === 1 ? '{cyan-fg}❯{/cyan-fg} ' : '  '}Proceed — submit ${count} unanswered`);
    lines.push('');
    lines.push('{gray-fg}↑/↓ choose · Enter confirm · Esc go back{/gray-fg}');
    return lines.join('\n');
  }
}
