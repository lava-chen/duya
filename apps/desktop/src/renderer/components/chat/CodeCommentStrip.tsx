import { useSyncExternalStore } from 'react';

import { XIcon } from '@/components/icons';
import {
  getPendingCodeComments,
  removeCodeComment,
  subscribeCodeComments,
} from '@/lib/code-comment-store';

function formatLineLabel(startLine: number, endLine: number): string {
  if (startLine === endLine) return `L${startLine}`;
  return `L${startLine}-L${endLine}`;
}

/**
 * Pending code-comment chips above the composer input. Reads the same
 * store the review panel's preview writes to, so submitting a comment in
 * the preview immediately shows it here and it rides along with the next
 * message (`buildCodeCommentsPromptBlock`). Removal here also removes the
 * inline card in the review panel — one source of truth.
 */
export function CodeCommentStrip({ workingDirectory }: { workingDirectory?: string | null }) {
  const workspacePath = workingDirectory ?? '';
  const comments = useSyncExternalStore(
    subscribeCodeComments,
    () => getPendingCodeComments(workspacePath),
    () => getPendingCodeComments(workspacePath),
  );

  if (!workspacePath || comments.length === 0) return null;

  return (
    <div className="code-review-comment-strip" role="list" aria-label="待发送的代码评论">
      {comments.map((comment) => {
        const fileName = comment.path.split(/[\\/]/).pop() || comment.path;
        const label = `${fileName}:${formatLineLabel(comment.startLine, comment.endLine)}`;
        const tooltip = `${comment.path} · ${formatLineLabel(comment.startLine, comment.endLine)}${
          comment.comment.trim() ? `\n${comment.comment}` : ''
        }`;
        return (
          <span
            key={comment.id}
            className="code-review-comment-strip-pill"
            role="listitem"
            title={tooltip}
          >
            <span className="code-review-comment-strip-pill-path">{label}</span>
            {comment.comment.trim() ? (
              <span className="code-review-comment-strip-pill-text">{comment.comment}</span>
            ) : null}
            <button
              type="button"
              className="code-review-comment-strip-pill-remove"
              aria-label={`移除 ${label} 的评论`}
              title="移除评论"
              onClick={() => removeCodeComment(workspacePath, comment.id)}
            >
              <XIcon size={10} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
