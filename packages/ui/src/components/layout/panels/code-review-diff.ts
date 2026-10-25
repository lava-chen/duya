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

export interface ReviewFilePatch {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary' | 'untracked';
  hunks: ReviewDiffHunk[];
  /**
   * This file's verbatim slice of the source patch (including the
   * `diff --git` line), fed straight into @pierre/diffs' `PatchDiff`.
   */
  raw: string;
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

/** Counts add/remove lines across hunks — the per-file (+N −M) diffstat. */
export function countPatchChanges(hunks: ReviewDiffHunk[]): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') additions += 1;
      else if (line.type === 'remove') removals += 1;
    }
  }
  return { additions, removals };
}

const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', mjs: 'JS', cjs: 'JS',
  css: 'CSS', scss: 'SCSS', less: 'LESS', html: 'HTML', vue: 'VUE',
  md: 'MD', json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML',
  toml: 'TOML', sh: 'SH', bash: 'SH', ps1: 'PS1', py: 'PY', rs: 'RS',
  go: 'GO', java: 'JAVA', kt: 'KT', c: 'C', h: 'H', cpp: 'C++', hpp: 'C++',
  cs: 'C#', rb: 'RB', php: 'PHP', sql: 'SQL', lua: 'LUA', swift: 'SWIFT',
};

/** Short uppercase language badge for a path (Codex-style), null when unknown. */
export function fileLanguageLabel(path: string): string | null {
  const match = path.match(/\.([A-Za-z0-9]+)$/);
  if (!match) return null;
  return LANGUAGE_LABELS[match[1].toLowerCase()] ?? null;
}

/** Splits a concatenated multi-file Git patch into per-file sections. */
export function parseReviewPatch(patch: string): ReviewFilePatch[] {
  const files: ReviewFilePatch[] = [];
  const lines = patch.split('\n');
  let current: ReviewFilePatch | null = null;
  let bodyLines: string[] = [];

  function finishCurrent() {
    if (current) {
      const body = bodyLines.join('\n');
      current.hunks = parseUnifiedDiff(body);
      current.raw = body;
      if (!current.status) current.status = 'modified';
      files.push(current);
    }
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finishCurrent();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = match ? match[2] : line.slice('diff --git '.length);
      current = { path, status: 'modified', hunks: [], raw: '' };
      bodyLines = [line];
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
