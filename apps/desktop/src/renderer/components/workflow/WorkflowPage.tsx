/**
 * WorkflowPage — the workflow management surface (plan 552 Phase 9 +
 * plan 556 Phase 5). Owns the page shell and switches between its three
 * views:
 *
 *   定义库   the saved library (WorkflowLibraryView) → detail page
 *   录制     recorded demonstrations (RecorderView) → convert to a definition
 *
 * The shell owns the PageFrame / PageHeader / PageTabs, so the two tab
 * bodies render embedded content only and the chrome never doubles up.
 * The detail page is a full-page takeover (it has its own breadcrumb
 * header), which is why it short-circuits before the shell renders.
 *
 * Refreshing a tab body is expressed as a `key` bump on the content
 * component: both bodies fetch on mount, and neither needs a callback
 * contract with the header.
 */

import { useEffect, useState } from 'react';

import { useTranslation } from '@/hooks/useTranslation';
import { IconRefresh } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { PageFrame, PageHeader, PageTabs } from '@/components/ui/page';
import { RecorderView } from '@/components/recorder/RecorderView';
import { WorkflowLibraryView } from './WorkflowLibraryView';
import { WorkflowDetailView } from './WorkflowDetailView';
import { WorkflowRunDetailView } from './WorkflowRunDetailView';

export interface WorkflowRunNavigationRequest {
  runId: string;
  nodeId?: string;
}

export interface WorkflowPageProps {
  projectDir?: string;
  projectName?: string;
  onCreateViaConversation?: (scope: 'global' | 'project', projectDir?: string) => void;
  /** Amend a saved workflow through a chat session (carries the user's own brief). */
  onAmendInChat?: (name: string, scope: 'global' | 'project', requirements: string) => void;
  runRequest?: WorkflowRunNavigationRequest | null;
  onRunRequestConsumed?: () => void;
}

type DetailTab = 'definition' | 'history';
type DetailState = { name: string; scope: 'global' | 'project'; tab: DetailTab } | null;
type TabId = 'definitions' | 'recordings';

export function WorkflowPage({
  projectDir,
  projectName,
  onCreateViaConversation,
  onAmendInChat,
  runRequest,
  onRunRequestConsumed,
}: WorkflowPageProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<DetailState>(null);
  const [tab, setTab] = useState<TabId>('definitions');
  /** Bumped by the header refresh — remounts the active tab body. */
  const [reloadKey, setReloadKey] = useState(0);
  const [openedRun, setOpenedRun] = useState<WorkflowRunNavigationRequest | null>(null);

  useEffect(() => {
    if (!runRequest) return;
    setOpenedRun(runRequest);
    onRunRequestConsumed?.();
  }, [runRequest?.runId, runRequest?.nodeId, onRunRequestConsumed]);

  if (openedRun) {
    return (
      <WorkflowRunDetailView
        key={`${openedRun.runId}:${openedRun.nodeId ?? ''}`}
        runId={openedRun.runId}
        focusNodeId={openedRun.nodeId}
        onBack={() => setOpenedRun(null)}
      />
    );
  }

  if (detail) {
    return (
      <WorkflowDetailView
        key={detail.name}
        name={detail.name}
        scope={detail.scope}
        projectDir={projectDir}
        initialTab={detail.tab}
        onTabChange={(nextTab) => {
          setDetail((current) => current ? { ...current, tab: nextTab } : current);
        }}
        onOpenRun={(runId, nodeId) => setOpenedRun({ runId, ...(nodeId ? { nodeId } : {}) })}
        onBack={() => setDetail(null)}
        onAmendInChat={onAmendInChat}
      />
    );
  }

  return (
    <PageFrame>
      <PageHeader
        title={t('nav.workflow')}
        subtitle={tab === 'definitions' ? t('automation.motto') : t('recorder.motto')}
        actions={
          <IconButton
            aria-label={t('recorder.refresh')}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            <IconRefresh size={14} />
          </IconButton>
        }
      />

      <PageTabs<TabId>
        variant="pill"
        testId="automation-tabs"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'definitions', label: t('recorder.tabDefinitions') },
          { id: 'recordings', label: t('recorder.tab') },
        ]}
      />

      {tab === 'definitions' ? (
        <WorkflowLibraryView
          key={reloadKey}
          embedded
          projectDir={projectDir}
          projectName={projectName}
          onCreateViaConversation={onCreateViaConversation}
          onOpenDetail={(name, scope) => setDetail({ name, scope, tab: 'definition' })}
        />
      ) : (
        <RecorderView
          key={reloadKey}
          projectDir={projectDir}
          // A newly saved definition only needs the library to refetch the
          // next time it mounts; bumping the key here does exactly that.
          onDefinitionSaved={() => setReloadKey((key) => key + 1)}
        />
      )}
    </PageFrame>
  );
}
