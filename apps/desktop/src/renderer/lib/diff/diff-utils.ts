/**
 * Diff utilities for code comparison
 * Based on claude-code-haha's diff implementation
 */

import { structuredPatch, diffWordsWithSpace, type StructuredPatchHunk } from 'diff';

export const CONTEXT_LINES = 3;
export const DIFF_TIMEOUT_MS = 5_000;

export interface DiffLine {
  code: string;
  type: 'add' | 'remove' | 'nochange';
  lineNumber: number;
  originalCode: string;
  wordDiff?: boolean;
  matchedLine?: DiffLine;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffStats {
  filesCount: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  isBinary: boolean;
  isLargeFile: boolean;
  isTruncated: boolean;
}

// For some reason, & confuses the diff library, so we replace it with a token,
// then substitute it back in after the diff is computed.
const AMPERSAND_TOKEN = '<<:AMPERSAND_TOKEN:>>';
const DOLLAR_TOKEN = '<<:DOLLAR_TOKEN:>>';

function escapeForDiff(s: string): string {
  return s.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN);
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, '&').replaceAll(DOLLAR_TOKEN, '$');
}

/**
 * Get patch from old and new content
 */
export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: {
  filePath: string;
  oldContent: string;
  newContent: string;
  ignoreWhitespace?: boolean;
  singleHunk?: boolean;
}): StructuredPatchHunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: singleHunk ? 100_000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    }
  );

  if (!result) {
    return [];
  }

  return result.hunks.map((h) => ({
    ...h,
    lines: h.lines.map(unescapeFromDiff),
  }));
}

/**
 * Transform patch lines to diff line objects
 */
export function transformLinesToObjects(lines: string[]): Omit<DiffLine, 'lineNumber'>[] {
  return lines.map((code) => {
    if (code.startsWith('+')) {
      return {
        code: code.slice(1),
        type: 'add' as const,
        originalCode: code.slice(1),
      };
    }
    if (code.startsWith('-')) {
      return {
        code: code.slice(1),
        type: 'remove' as const,
        originalCode: code.slice(1),
      };
    }
    return {
      code: code.slice(1),
      type: 'nochange' as const,
      originalCode: code.slice(1),
    };
  });
}

/**
 * Process adjacent add/remove lines for word-level diffing
 */
export function processAdjacentLines(
  lineObjects: Omit<DiffLine, 'lineNumber'>[]
): Omit<DiffLine, 'lineNumber'>[] {
  const processedLines: Omit<DiffLine, 'lineNumber'>[] = [];
  let i = 0;

  while (i < lineObjects.length) {
    const current = lineObjects[i];
    if (!current) {
      i++;
      continue;
    }

    // Find a sequence of remove followed by add (possible word-level diff candidates)
    if (current.type === 'remove') {
      const removeLines: Omit<DiffLine, 'lineNumber'>[] = [current];
      let j = i + 1;

      // Collect consecutive remove lines
      while (j < lineObjects.length && lineObjects[j]?.type === 'remove') {
        const line = lineObjects[j];
        if (line) {
          removeLines.push(line);
        }
        j++;
      }

      // Check if there are add lines following the remove lines
      const addLines: Omit<DiffLine, 'lineNumber'>[] = [];
      while (j < lineObjects.length && lineObjects[j]?.type === 'add') {
        const line = lineObjects[j];
        if (line) {
          addLines.push(line);
        }
        j++;
      }

      // If we have both remove and add lines, perform word-level diffing
      if (removeLines.length > 0 && addLines.length > 0) {
        const pairCount = Math.min(removeLines.length, addLines.length);

        // Add paired lines with word diff info
        for (let k = 0; k < pairCount; k++) {
          const removeLine = removeLines[k];
          const addLine = addLines[k];
          if (removeLine && addLine) {
            removeLine.wordDiff = true;
            addLine.wordDiff = true;
            removeLine.matchedLine = addLine as DiffLine;
            addLine.matchedLine = removeLine as DiffLine;
          }
        }

        processedLines.push(...removeLines.filter(Boolean));
        processedLines.push(...addLines.filter(Boolean));
        i = j;
      } else {
        processedLines.push(current);
        i++;
      }
    } else {
      processedLines.push(current);
      i++;
    }
  }

  return processedLines;
}

/**
 * Calculate word-level diffs between two text strings
 */
export function calculateWordDiffs(
  oldText: string,
  newText: string
): { added?: boolean; removed?: boolean; value: string }[] {
  return diffWordsWithSpace(oldText, newText, {
    ignoreCase: false,
  });
}

/**
 * Number the diff lines
 */
export function numberDiffLines(
  diff: Omit<DiffLine, 'lineNumber'>[],
  startLine: number
): DiffLine[] {
  let i = startLine;
  const result: DiffLine[] = [];
  const queue = [...diff];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const { code, type, originalCode, wordDiff, matchedLine } = current;

    const line: DiffLine = {
      code,
      type,
      lineNumber: i,
      originalCode,
      wordDiff,
      matchedLine,
    };

    switch (type) {
      case 'nochange':
        i++;
        result.push(line);
        break;
      case 'add':
        i++;
        result.push(line);
        break;
      case 'remove': {
        result.push(line);
        let numRemoved = 0;
        while (queue[0]?.type === 'remove') {
          i++;
          const current = queue.shift()!;
          const line: DiffLine = {
            code: current.code,
            type: current.type,
            lineNumber: i,
            originalCode: current.originalCode,
            wordDiff: current.wordDiff,
            matchedLine: current.matchedLine,
          };
          result.push(line);
          numRemoved++;
        }
        i -= numRemoved;
        break;
      }
    }
  }

  return result;
}

/**
 * Convert StructuredPatchHunk to our DiffHunk format
 */
export function convertToDiffHunk(hunk: StructuredPatchHunk): DiffHunk {
  const lineObjects = transformLinesToObjects(hunk.lines);
  const processedLines = processAdjacentLines(lineObjects);
  const numberedLines = numberDiffLines(processedLines, hunk.oldStart);

  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: numberedLines,
  };
}

/**
 * Count lines added and removed
 */
export function countLinesChanged(hunks: DiffHunk[]): {
  additions: number;
  removals: number;
} {
  let additions = 0;
  let removals = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') additions++;
      if (line.type === 'remove') removals++;
    }
  }

  return { additions, removals };
}

/**
 * Get language from file extension
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
    jsx: 'jsx',
    py: 'python',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    rb: 'ruby',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'zsh',
    sql: 'sql',
    dockerfile: 'dockerfile',
    vue: 'vue',
    svelte: 'svelte',
  };
  return langMap[ext] || 'text';
}
