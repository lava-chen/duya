export type ReviewDiffLineType = 'context' | 'add' | 'remove';

export interface ReviewDiffLine {
  type: ReviewDiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface ReviewDiffHunk {
  header: string;
  lines: ReviewDiffLine[];
}

export interface CollapsedReviewLines {
  type: 'collapsed';
  count: number;
}

export type ReviewDisplayLine = ReviewDiffLine | CollapsedReviewLines;

export type ReviewSplitRow =
  | { type: 'line'; oldLine?: ReviewDiffLine; newLine?: ReviewDiffLine }
  | CollapsedReviewLines;

export interface ReviewFilePatch {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary' | 'untracked';
  hunks: ReviewDiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the text-only body of a unified Git patch into line-addressable hunks. */
export function parseUnifiedDiff(patch: string): ReviewDiffHunk[] {
  const hunks: ReviewDiffHunk[] = [];
  let current: ReviewDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const sourceLine of patch.split('\n')) {
    const header = sourceLine.match(HUNK_HEADER);
    if (header) {
      oldLine = Number.parseInt(header[1], 10);
      newLine = Number.parseInt(header[3], 10);
      current = { header: sourceLine, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current || sourceLine === '\\ No newline at end of file') continue;

    const prefix = sourceLine[0];
    const content = sourceLine.slice(1);
    if (prefix === ' ') {
      current.lines.push({ type: 'context', content, oldLineNumber: oldLine, newLineNumber: newLine });
      oldLine += 1;
      newLine += 1;
    } else if (prefix === '-') {
      current.lines.push({ type: 'remove', content, oldLineNumber: oldLine });
      oldLine += 1;
    } else if (prefix === '+') {
      current.lines.push({ type: 'add', content, newLineNumber: newLine });
      newLine += 1;
    }
  }

  return hunks;
}

/** Replaces long unchanged runs with an explicit, expandable context marker. */
export function collapseContextLines(
  lines: ReviewDiffLine[],
  collapsed: boolean,
  visibleContext = 3,
): ReviewDisplayLine[] {
  if (!collapsed) return lines;

  const result: ReviewDisplayLine[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.type !== 'context') {
      result.push(line);
      index += 1;
      continue;
    }

    let end = index;
    while (end < lines.length && lines[end].type === 'context') end += 1;
    const run = lines.slice(index, end);
    const hiddenCount = run.length - visibleContext * 2;
    if (hiddenCount > 0) {
      result.push(...run.slice(0, visibleContext));
      result.push({ type: 'collapsed', count: hiddenCount });
      result.push(...run.slice(-visibleContext));
    } else {
      result.push(...run);
    }
    index = end;
  }
  return result;
}

/** Aligns deletion/addition runs into rows for a side-by-side diff. */
export function toSplitRows(lines: ReviewDisplayLine[]): ReviewSplitRow[] {
  const rows: ReviewSplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.type === 'collapsed') {
      rows.push(line);
      index += 1;
      continue;
    }
    if (line.type === 'context') {
      rows.push({ type: 'line', oldLine: line, newLine: line });
      index += 1;
      continue;
    }

    const removed: ReviewDiffLine[] = [];
    const added: ReviewDiffLine[] = [];
    while (index < lines.length && lines[index].type !== 'context' && lines[index].type !== 'collapsed') {
      const changed = lines[index] as ReviewDiffLine;
      if (changed.type === 'remove') removed.push(changed);
      if (changed.type === 'add') added.push(changed);
      index += 1;
    }
    const rowCount = Math.max(removed.length, added.length);
    for (let row = 0; row < rowCount; row += 1) {
      rows.push({ type: 'line', oldLine: removed[row], newLine: added[row] });
    }
  }
  return rows;
}

/** Splits a concatenated multi-file Git patch into per-file sections. */
export function parseReviewPatch(patch: string): ReviewFilePatch[] {
  const files: ReviewFilePatch[] = [];
  const lines = patch.split('\n');
  let current: ReviewFilePatch | null = null;
  let bodyLines: string[] = [];

  function finishCurrent() {
    if (current) {
      current.hunks = parseUnifiedDiff(bodyLines.join('\n'));
      if (!current.status) current.status = 'modified';
      files.push(current);
    }
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finishCurrent();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = match ? match[2] : line.slice('diff --git '.length);
      current = { path, status: 'modified', hunks: [] };
      bodyLines = [];
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) current.oldPath = line.slice('rename from '.length);
    else if (line.startsWith('rename to ')) current.path = line.slice('rename to '.length);
    else if (line.startsWith('similarity index') || line.startsWith('rename from') || line.startsWith('rename to')) {
      current.status = 'renamed';
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.status = 'binary';
    }

    bodyLines.push(line);
  }
  finishCurrent();
  return files;
}
