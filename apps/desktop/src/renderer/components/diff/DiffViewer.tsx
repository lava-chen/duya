/**
 * DiffViewer Component
 * Renders code diffs with syntax highlighting and word-level diff
 * Inspired by claude-code-haha's diff implementation
 */

'use client';

import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  convertToDiffHunk,
  countLinesChanged,
  getLanguageFromPath,
  calculateWordDiffs,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
} from '@/lib/diff/diff-utils';
import { FileIcon, PlusIcon, MinusIcon, CaretDownIcon } from '@/components/icons';

// Threshold for when we show a full-line diff instead of word-level diffing
const CHANGE_THRESHOLD = 0.4;

export interface DiffViewerProps {
  filePath: string;
  oldContent?: string;
  newContent: string;
  oldPath?: string;
  showStats?: boolean;
  maxHeight?: number;
  className?: string;
  defaultExpanded?: boolean;
}

interface WordDiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * Render word-level diff for a line
 */
function WordDiffRenderer({
  line,
  matchedLine,
  type,
}: {
  line: DiffLine;
  matchedLine: DiffLine;
  type: 'add' | 'remove';
}) {
  const wordDiffs = useMemo(() => {
    const removedText = type === 'remove' ? line.originalCode : matchedLine.originalCode;
    const addedText = type === 'remove' ? matchedLine.originalCode : line.originalCode;
    return calculateWordDiffs(removedText, addedText);
  }, [line.originalCode, matchedLine.originalCode, type]);

  // Check if we should use word-level diffing
  const totalLength = line.originalCode.length + matchedLine.originalCode.length;
  const changedLength = wordDiffs
    .filter((part) => part.added || part.removed)
    .reduce((sum, part) => sum + part.value.length, 0);
  const changeRatio = changedLength / totalLength;

  if (changeRatio > CHANGE_THRESHOLD) {
    return <span>{line.code}</span>;
  }

  return (
    <>
      {wordDiffs.map((part, idx) => {
        // Determine if this part should be shown for this line type
        if (type === 'add') {
          if (part.added) {
            return (
              <span
                key={idx}
                className="bg-green-500/30 rounded px-0.5"
              >
                {part.value}
              </span>
            );
          } else if (!part.removed) {
            return <span key={idx}>{part.value}</span>;
          }
        } else if (type === 'remove') {
          if (part.removed) {
            return (
              <span
                key={idx}
                className="bg-red-500/30 rounded px-0.5"
              >
                {part.value}
              </span>
            );
          } else if (!part.added) {
            return <span key={idx}>{part.value}</span>;
          }
        }
        return null;
      })}
    </>
  );
}

/**
 * Single diff line component
 */
function DiffLineComponent({
  line,
  maxLineNumber,
  showWordDiff,
}: {
  line: DiffLine;
  maxLineNumber: number;
  showWordDiff: boolean;
}) {
  const lineNumWidth = maxLineNumber.toString().length;
  const bgColorClass =
    line.type === 'add'
      ? 'bg-green-500/10'
      : line.type === 'remove'
      ? 'bg-red-500/10'
      : '';
  const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
  const prefixColorClass =
    line.type === 'add'
      ? 'text-green-500'
      : line.type === 'remove'
      ? 'text-red-500'
      : 'text-gray-500';

  const content = showWordDiff && line.wordDiff && line.matchedLine && (line.type === 'add' || line.type === 'remove') ? (
    <WordDiffRenderer
      line={line}
      matchedLine={line.matchedLine}
      type={line.type}
    />
  ) : (
    line.code
  );

  return (
    <div className={`flex ${bgColorClass} font-mono text-[13px] leading-6`}>
      {/* Line number */}
      <div className="shrink-0 w-12 text-right pr-2 text-gray-500 select-none">
        {line.lineNumber.toString().padStart(lineNumWidth, ' ')}
      </div>
      {/* Prefix */}
      <div className={`shrink-0 w-4 text-center select-none ${prefixColorClass}`}>
        {prefix}
      </div>
      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <pre className="m-0 p-0 bg-transparent text-inherit whitespace-pre-wrap break-all">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Diff hunk component
 */
function DiffHunkComponent({
  hunk,
  maxLineNumber,
  showWordDiff,
}: {
  hunk: DiffHunk;
  maxLineNumber: number;
  showWordDiff: boolean;
}) {
  return (
    <div className="my-2">
      {/* Hunk header */}
      <div className="px-3 py-1 text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 font-mono">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {/* Lines */}
      <div>
        {hunk.lines.map((line, idx) => (
          <DiffLineComponent
            key={idx}
            line={line}
            maxLineNumber={maxLineNumber}
            showWordDiff={showWordDiff}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * File header component with toggle
 */
function FileHeader({
  filePath,
  oldPath,
  stats,
  isExpanded,
  onToggle,
}: {
  filePath: string;
  oldPath?: string;
  stats: { additions: number; removals: number };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const language = getLanguageFromPath(filePath);

  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0">
        <CaretDownIcon 
          size={14} 
          className={`text-gray-400 shrink-0 transition-transform duration-200 ${isExpanded ? '' : '-rotate-90'}`}
        />
        <FileIcon size={16} className="text-gray-400 shrink-0" />
        <span className="text-sm font-medium truncate" title={filePath}>
          {fileName}
        </span>
        {oldPath && oldPath !== filePath && (
          <span className="text-xs text-gray-500 truncate" title={`Renamed from ${oldPath}`}>
            ← {oldPath.split(/[/\\]/).pop()}
          </span>
        )}
        <span className="text-xs text-gray-400 shrink-0">{language}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {stats.additions > 0 && (
          <span className="flex items-center gap-1 text-xs text-green-600">
            <PlusIcon size={12} />
            {stats.additions}
          </span>
        )}
        {stats.removals > 0 && (
          <span className="flex items-center gap-1 text-xs text-red-600">
            <MinusIcon size={12} />
            {stats.removals}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * Main DiffViewer component
 */
export function DiffViewer({
  filePath,
  oldContent = '',
  newContent,
  oldPath,
  showStats = true,
  maxHeight = 400,
  className = '',
  defaultExpanded = true,
}: DiffViewerProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  
  const { hunks, stats, maxLineNumber } = useMemo(() => {
    // Generate patch from old and new content
    const patch = generatePatch(filePath, oldContent, newContent);
    const hunks = patch.map(convertToDiffHunk);
    const stats = countLinesChanged(hunks);
    const maxLineNumber = hunks.reduce((max, hunk) => {
      const hunkMax = Math.max(
        hunk.oldStart + hunk.oldLines - 1,
        hunk.newStart + hunk.newLines - 1,
        1
      );
      return Math.max(max, hunkMax);
    }, 0);

    return { hunks, stats, maxLineNumber };
  }, [filePath, oldContent, newContent]);

  if (hunks.length === 0) {
    return (
      <div className={`rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden ${className}`}>
        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <FileIcon size={16} className="text-gray-400" />
            <span className="text-sm font-medium">{filePath.split(/[/\\]/).pop()}</span>
          </div>
        </div>
        <div className="p-4 text-sm text-gray-500 text-center">No changes</div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden ${className}`}
    >
      <FileHeader 
        filePath={filePath} 
        oldPath={oldPath} 
        stats={stats}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div
              className="overflow-auto custom-scrollbar"
              style={{ maxHeight }}
            >
              {hunks.map((hunk, idx) => (
                <DiffHunkComponent
                  key={idx}
                  hunk={hunk}
                  maxLineNumber={maxLineNumber}
                  showWordDiff={true}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Helper function to generate patch
import { structuredPatch } from 'diff';

function generatePatch(
  filePath: string,
  oldContent: string,
  newContent: string
): import('diff').StructuredPatchHunk[] {
  const result = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: 3,
  });
  return result?.hunks || [];
}

/**
 * Multi-file diff viewer
 */
export interface MultiFileDiffViewerProps {
  files: FileDiff[];
  className?: string;
}

export function MultiFileDiffViewer({ files, className = '' }: MultiFileDiffViewerProps) {
  const totalStats = useMemo(() => {
    return files.reduce(
      (acc, file) => ({
        additions: acc.additions + file.linesAdded,
        removals: acc.removals + file.linesRemoved,
      }),
      { additions: 0, removals: 0 }
    );
  }, [files]);

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Summary header */}
      <div className="flex items-center gap-4 text-sm">
        <span className="font-medium">{files.length} files changed</span>
        {totalStats.additions > 0 && (
          <span className="text-green-600">+{totalStats.additions}</span>
        )}
        {totalStats.removals > 0 && (
          <span className="text-red-600">-{totalStats.removals}</span>
        )}
      </div>

      {/* File diffs */}
      {files.map((file, idx) => (
        <DiffViewer
          key={idx}
          filePath={file.path}
          oldContent={file.isNewFile ? '' : undefined}
          newContent={''} // Would need to reconstruct from hunks
          showStats={false}
        />
      ))}
    </div>
  );
}
