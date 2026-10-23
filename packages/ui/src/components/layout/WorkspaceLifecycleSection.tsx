// packages/ui/src/components/layout/WorkspaceLifecycleSection.tsx
//
// The workspace-lifecycle section of the session-detail drawer (plan 621).
//
// It hosts the ONE shared panel that answers "which checkout is this session
// in, who owns it, can it be reclaimed, what pull requests has it produced".
// Desktop, TUI and Web each install their own adapter for the port; this
// component never learns which transport answered.
//
// The section is absent — not empty — when the surface installed no adapter.
// A section whose only content is "this surface cannot answer" is noise in
// every build that does not serve the Host's checkout namespace, and the
// honest statement there is that the surface does not have the feature.

'use client';

import { useConversationStore } from '@/stores/conversation-store';
import { useWorkspaceLifecycle } from '@/hooks/useWorkspaceLifecycle';
import { WorkspaceLifecyclePanel } from '@/components/workspace/WorkspaceLifecyclePanel';

export function WorkspaceLifecycleSection() {
  const port = useWorkspaceLifecycle();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

  if (port === null) return null;
  if (activeThreadId === null || activeThreadId === '') return null;

  return <WorkspaceLifecyclePanel sessionId={activeThreadId} />;
}
