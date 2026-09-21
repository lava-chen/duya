/**
 * AutomationPage — wrapper that toggles between AutomationView (library list)
 * and AutomationDetailView (workflow detail page). Replaces the old
 * WorkflowView entry point; the ChatView-embedded WorkflowPanel keeps
 * working unchanged.
 */

import { useState } from 'react';
import { AutomationView } from './AutomationView';
import { AutomationDetailView } from './AutomationDetailView';

export interface AutomationPageProps {
  projectDir?: string;
  projectName?: string;
  onCreateViaConversation?: (scope: 'global' | 'project', projectDir?: string) => void;
  onAmendInChat?: (name: string, scope: 'global' | 'project') => void;
}

type DetailState = { name: string; scope: 'global' | 'project' } | null;

export function AutomationPage({
  projectDir,
  projectName,
  onCreateViaConversation,
  onAmendInChat,
}: AutomationPageProps) {
  const [detail, setDetail] = useState<DetailState>(null);

  if (detail) {
    return (
      <AutomationDetailView
        name={detail.name}
        scope={detail.scope}
        projectDir={projectDir}
        onBack={() => setDetail(null)}
        onAmendInChat={onAmendInChat}
      />
    );
  }

  return (
    <AutomationView
      projectDir={projectDir}
      projectName={projectName}
      onCreateViaConversation={onCreateViaConversation}
      onOpenDetail={(name, scope) => setDetail({ name, scope })}
    />
  );
}