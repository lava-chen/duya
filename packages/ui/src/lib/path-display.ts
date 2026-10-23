// Path display helpers for the transcript chrome.
//
// The chat rows show a file NAME (the tail of the path) because that
// is what the reader recognises. The expanded diff card shows the
// FULL path instead — but a full Windows path is far wider than the
// chat column, so it gets truncated in the middle: the head (where the
// project lives) and the tail (the file name) are the two parts worth
// keeping.

/**
 * Truncate a path in the middle, keeping the head and the tail.
 *
 *   E:\Projects\duya\packages\ui\src\components\chat\ToolActionsGroup.tsx
 *   → E:\Projects\duya\packages\ui\src\components…ToolActionsGroup.tsx
 *
 * The file name is never cut: it is the part the reader recognises, and a
 * truncated file name ("ActionsGroup.tsx") is worse than no path at all.
 * The head gives way instead, because the project root at its start is
 * what says WHERE the file lives.
 */
export function truncatePathMiddle(path: string, maxLength = 64): string {
  if (!path) return '';
  if (path.length <= maxLength) return path;

  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const fileName = separator >= 0 ? path.slice(separator + 1) : path;
  const head = separator >= 0 ? path.slice(0, separator) : '';
  const ellipsis = '…';

  // A file name that does not fit on its own: keep its tail, which is the
  // extension and the stem the reader scans for.
  if (fileName.length + ellipsis.length >= maxLength) {
    return `${ellipsis}${fileName.slice(fileName.length - (maxLength - ellipsis.length))}`;
  }

  const headBudget = maxLength - ellipsis.length - fileName.length;
  if (head.length <= headBudget) {
    return `${head}${ellipsis}${fileName}`;
  }
  return `${head.slice(0, headBudget)}${ellipsis}${fileName}`;
}
