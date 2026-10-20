import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  addCodeComment,
  getCodeComments,
  removeCodeComment,
  subscribeCodeComments,
  type CodeComment,
  type CodeCommentDraft,
} from '@/lib/code-comment-store';

/**
 * Subscribes the component to one workspace's comment bucket. Returns a
 * stable snapshot reference plus the two mutations the UI needs.
 */
export function useCodeComments(workspacePath: string): {
  comments: readonly CodeComment[];
  addComment: (draft: CodeCommentDraft) => void;
  removeComment: (id: string) => void;
} {
  const comments = useSyncExternalStore(
    subscribeCodeComments,
    () => getCodeComments(workspacePath),
    () => getCodeComments(workspacePath),
  );

  const addComment = useCallback(
    (draft: CodeCommentDraft) => {
      addCodeComment(workspacePath, draft);
    },
    [workspacePath],
  );

  const removeComment = useCallback(
    (id: string) => {
      removeCodeComment(workspacePath, id);
    },
    [workspacePath],
  );

  return useMemo(() => ({ comments, addComment, removeComment }), [comments, addComment, removeComment]);
}
