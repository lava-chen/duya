/**
 * AutomationDetailView — full-screen definition detail page (plan 552 Phase 9).
 *
 * Layout (matches the user's preferred design):
 *   面包屑  自动化 > 全局 > <workflow-name>
 *   顶部    ▶ 运行  ···      (and refresh)
 *   路径栏  ~/.duya/workflows/<name>.yaml         [复制]
 *   Tabs    [定义] | [运行历史]
 *
 *   定义 Tab
 *     说明 (description)
 *     使用时机 (when_to_use) — small caption: 给模型的路由提示
 *     参数表  (name / type / required / default / description)
 *       [+ 添加参数]  只改写文件顶部的元数据，脚本正文保持原样
 *     脚本 (node graph via WorkflowGraph)
 *       脚本只读。要改脚本，在对话里让 ZCode 修订后另存一版
 *
 *   运行历史 Tab — list of past runs (delegate to RunsTab)
 */

import { useEffect, useState, useCallback, type CSSProperties } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  PlayIcon,
  CopyIcon,
  CheckIcon,
  CaretRightIcon,
  PencilIcon,
  DotsThreeIcon,
  IconRefresh,
  RepeatIcon,
  PlusIcon,
  WarningIcon,
} from '@/components/icons';
import { PageFrame, PageCard, EmptyState } from '@/components/ui/page';
import { WorkflowGraph } from './WorkflowGraph';
import { RunsTab } from '@/components/layout/panels/WorkflowPanel';
import {
  getWorkflowDefIPC,
  triggerWorkflowRunIPC,
  type WorkflowDefinitionSummary,
} from '@/lib/workflow-ipc';
import type {
  WorkflowDefView,
  WorkflowNodeView,
  WorkflowParamView,
  WorkflowPhaseView,
} from '@/lib/workflow-types';
import { deriveNodeKind } from '@/lib/workflow-types';

// ─── styles ────────────────────────────────────────────────────────────────

const breadcrumbStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2, 8px)',
  fontSize: '13px',
  color: 'var(--text-faint)',
};

const breadcrumbLinkStyle: CSSProperties = {
  cursor: 'pointer',
  color: 'var(--text-faint)',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
};

const breadcrumbCurrentStyle: CSSProperties = {
  color: 'var(--text)',
  fontWeight: 500,
};

const topBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3, 12px)',
  marginBottom: 'var(--space-3, 12px)',
};

const actionGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2, 8px)',
};

const runButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '8px 14px',
  background: 'var(--accent)',
  color: 'var(--accent-on, #fff)',
  border: 'none',
  borderRadius: '6px',
  fontWeight: 500,
  fontSize: '13px',
  cursor: 'pointer',
};

const ghostButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '6px 10px',
  background: 'transparent',
  color: 'var(--text-faint)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
};

const pathBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3, 12px)',
  padding: '8px 12px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  fontSize: '12px',
  marginBottom: 'var(--space-4, 16px)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
};

const pathTextStyle: CSSProperties = {
  flex: 1,
  color: 'var(--text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const tabsStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--space-2, 8px)',
  borderBottom: '1px solid var(--border-weak)',
  marginBottom: 'var(--space-4, 16px)',
};

const tabStyle = (active: boolean): CSSProperties => ({
  padding: '8px 14px',
  fontSize: '13px',
  fontWeight: active ? 500 : 400,
  color: active ? 'var(--text)' : 'var(--text-faint)',
  background: 'none',
  border: 'none',
  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
  cursor: 'pointer',
  marginBottom: '-1px',
});

const sectionTitleStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text-faint)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 'var(--space-2, 8px)',
};

const captionStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  fontStyle: 'italic',
  marginTop: '4px',
};

const paramsTableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '13px',
};

const paramsThStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  borderBottom: '1px solid var(--border-weak)',
  color: 'var(--text-faint)',
  fontWeight: 500,
  fontSize: '12px',
};

const paramsTdStyle: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--border-weak)',
  color: 'var(--text)',
};

const addParamButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '6px 10px',
  marginTop: 'var(--space-2, 8px)',
  background: 'transparent',
  color: 'var(--accent)',
  border: '1px dashed var(--border-weak)',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '12px',
};

const readonlyHintStyle: CSSProperties = {
  marginTop: 'var(--space-3, 12px)',
  padding: '10px 12px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  fontSize: '12px',
  color: 'var(--text-faint)',
};

// ─── helpers ───────────────────────────────────────────────────────────────

function coerceDef(raw: unknown): WorkflowDefView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;

  const phases: WorkflowPhaseView[] = Array.isArray(r.phases)
    ? (r.phases as Array<Record<string, unknown>>).map((p) => {
        const nodes = Array.isArray(p.nodes)
          ? (p.nodes as Array<Record<string, unknown>>).map((n) => {
              const node: WorkflowNodeView = {
                id: String(n.id ?? ''),
                kind: deriveNodeKind(n as Partial<WorkflowNodeView>),
                tool: typeof n.tool === 'string' ? n.tool : undefined,
                input: (n.input as Record<string, unknown> | undefined) ?? undefined,
                gui: n.gui as WorkflowNodeView['gui'],
                decision: n.decision as WorkflowNodeView['decision'],
                human: n.human as WorkflowNodeView['human'],
                agent: typeof n.agent === 'string' ? n.agent : undefined,
                prompt: typeof n.prompt === 'string' ? n.prompt : undefined,
                model: typeof n.model === 'string' ? n.model : undefined,
                output_schema: n.output_schema as Record<string, unknown> | undefined,
                noop: n.noop === true,
                when: typeof n.when === 'string' ? n.when : undefined,
                on_error: n.on_error as WorkflowNodeView['on_error'],
                max_retries: typeof n.max_retries === 'number' ? n.max_retries : undefined,
              };
              return node;
            })
          : [];
        return {
          phase: String(p.phase ?? ''),
          title: String(p.title ?? p.phase ?? ''),
          detail: typeof p.detail === 'string' ? p.detail : undefined,
          nodes,
        };
      })
    : [];

  const params: WorkflowParamView[] = Array.isArray(r.params)
    ? (r.params as Array<Record<string, unknown>>).map((p) => ({
        name: String(p.name ?? ''),
        type: (p.type as WorkflowParamView['type']) ?? 'string',
        required: p.required === true,
        default: p.default,
      }))
    : [];

  return {
    name: r.name,
    description: typeof r.description === 'string' ? r.description : '',
    when_to_use: typeof r.when_to_use === 'string' ? r.when_to_use : undefined,
    params,
    triggers: Array.isArray(r.triggers) ? (r.triggers as Array<'cron' | 'bot' | 'http'>) : undefined,
    phases,
  };
}

// ─── component ─────────────────────────────────────────────────────────────

export interface AutomationDetailViewProps {
  name: string;
  scope?: 'global' | 'project';
  /** Path to navigate back to the library. */
  onBack: () => void;
  projectDir?: string;
  /** Open a chat session pre-filled with a prompt to amend this workflow. */
  onAmendInChat?: (name: string, scope: 'global' | 'project') => void;
}

type TabKey = 'definition' | 'history';

export function AutomationDetailView({
  name,
  scope = 'global',
  onBack,
  projectDir,
  onAmendInChat,
}: AutomationDetailViewProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('definition');
  const [def, setDef] = useState<WorkflowDefView | null>(null);
  const [summary, setSummary] = useState<WorkflowDefinitionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getWorkflowDefIPC({ name, projectDir });
      if (res && 'error' in res) {
        setError(String(res.error));
        setDef(null);
      } else if (res && 'summary' in res) {
        setSummary(res.summary ?? null);
        setDef(coerceDef(res.definition));
      } else {
        setError('not_found');
        setDef(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [name, projectDir]);

  useEffect(() => {
    reload();
  }, [reload]);

  const filePath = summary?.file ?? `~/.duya/workflows/${name}.yaml`;
  const scopeLabel = scope === 'project' ? t('workflow.scopeProject') : t('workflow.scopeGlobal');

  const handleRun = useCallback(async () => {
    const res = await triggerWorkflowRunIPC({ name, projectDir });
    if (!res?.ok) {
      setError(res?.error ?? 'failed to start');
      return;
    }
    setTab('history');
  }, [name, projectDir]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  }, [filePath]);

  return (
    <PageFrame>
      {/* Breadcrumb */}
      <div style={breadcrumbStyle}>
        <button style={breadcrumbLinkStyle} onClick={onBack}>
          {t('nav.workflow')}
        </button>
        <CaretRightIcon size={12} />
        <span style={breadcrumbLinkStyle} onClick={onBack}>
          {scopeLabel}
        </span>
        <CaretRightIcon size={12} />
        <span style={breadcrumbCurrentStyle}>{name}</span>
      </div>

      {/* Top action bar */}
      <div style={topBarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3, 12px)' }}>
          <RepeatIcon size={20} />
          <div>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>{def?.description || name}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-faint)' }}>
              {def?.phases.length ?? 0} {t('workflow.detail.phases')} ·{' '}
              {def?.phases.reduce((sum, p) => sum + p.nodes.length, 0) ?? 0}{' '}
              {t('workflow.detail.steps')}
            </div>
          </div>
        </div>
        <div style={actionGroupStyle}>
          <button style={ghostButtonStyle} onClick={reload} aria-label="refresh">
            <IconRefresh size={14} />
          </button>
          <button style={runButtonStyle} onClick={handleRun}>
            <PlayIcon size={12} />
            {t('workflow.action.run')}
          </button>
          <button style={ghostButtonStyle} aria-label="more">
            <DotsThreeIcon size={16} />
          </button>
        </div>
      </div>

      {/* Path bar */}
      <div style={pathBarStyle}>
        <span style={pathTextStyle}>{filePath}</span>
        <button style={ghostButtonStyle} onClick={handleCopyPath}>
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          {copied ? t('workflow.copied') : t('workflow.copy')}
        </button>
      </div>

      {/* Tabs */}
      <div style={tabsStyle} role="tablist">
        <button
          style={tabStyle(tab === 'definition')}
          onClick={() => setTab('definition')}
          role="tab"
          aria-selected={tab === 'definition'}
        >
          {t('workflow.tab.definition')}
        </button>
        <button
          style={tabStyle(tab === 'history')}
          onClick={() => setTab('history')}
          role="tab"
          aria-selected={tab === 'history'}
        >
          {t('workflow.tab.history')}
        </button>
      </div>

      {error && (
        <PageCard>
          <EmptyState
            icon={<WarningIcon size={24} />}
            title={t('workflow.error.title')}
            description={error}
          />
        </PageCard>
      )}

      {!error && tab === 'definition' && (
        <DefinitionTab
          def={def}
          loading={loading}
          onAmendInChat={onAmendInChat ? () => onAmendInChat(name, scope) : undefined}
        />
      )}

      {!error && tab === 'history' && (
        <div style={{ paddingTop: 'var(--space-2, 8px)' }}>
          <RunsTab />
        </div>
      )}
    </PageFrame>
  );
}

// ─── definition tab ────────────────────────────────────────────────────────

function DefinitionTab({
  def,
  loading,
  onAmendInChat,
}: {
  def: WorkflowDefView | null;
  loading: boolean;
  onAmendInChat?: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <PageCard>
        <EmptyState title={t('workflow.loading')} icon={<RepeatIcon size={20} />} />
      </PageCard>
    );
  }
  if (!def) {
    return (
      <PageCard>
        <EmptyState title={t('workflow.notFound')} icon={<RepeatIcon size={20} />} />
      </PageCard>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4, 16px)' }}>
      {/* Description */}
      <PageCard>
        <div style={sectionTitleStyle}>{t('workflow.field.description')}</div>
        <div style={{ fontSize: '14px', color: 'var(--text)' }}>{def.description}</div>
        {def.when_to_use && (
          <>
            <div style={{ ...sectionTitleStyle, marginTop: 'var(--space-3, 12px)' }}>
              {t('workflow.field.whenToUse')}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text)' }}>{def.when_to_use}</div>
            <div style={captionStyle}>{t('workflow.field.whenToUse.hint')}</div>
          </>
        )}
      </PageCard>

      {/* Parameters */}
      <PageCard>
        <div style={sectionTitleStyle}>{t('workflow.field.parameters')}</div>
        {def.params.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-faint)' }}>
            {t('workflow.field.parameters.empty')}
          </div>
        ) : (
          <table style={paramsTableStyle}>
            <thead>
              <tr>
                <th style={paramsThStyle}>{t('workflow.field.parameters.name')}</th>
                <th style={paramsThStyle}>{t('workflow.field.parameters.type')}</th>
                <th style={paramsThStyle}>{t('workflow.field.parameters.required')}</th>
                <th style={paramsThStyle}>{t('workflow.field.parameters.default')}</th>
                <th style={paramsThStyle}>{t('workflow.field.parameters.desc')}</th>
                <th style={paramsThStyle}></th>
              </tr>
            </thead>
            <tbody>
              {def.params.map((p) => (
                <tr key={p.name}>
                  <td style={{ ...paramsTdStyle, fontFamily: 'var(--font-mono)' }}>{p.name}</td>
                  <td style={paramsTdStyle}>{p.type}</td>
                  <td style={paramsTdStyle}>{p.required ? '✓' : ''}</td>
                  <td style={{ ...paramsTdStyle, fontFamily: 'var(--font-mono)' }}>
                    {p.default === undefined ? '—' : JSON.stringify(p.default)}
                  </td>
                  <td style={paramsTdStyle}>—</td>
                  <td style={paramsTdStyle}>
                    <button style={ghostButtonStyle} aria-label="edit">
                      <PencilIcon size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button style={addParamButtonStyle}>
          <PlusIcon size={12} />
          {t('workflow.field.parameters.add')}
        </button>
        <div style={captionStyle}>{t('workflow.field.parameters.editHint')}</div>
      </PageCard>

      {/* Script (node graph) */}
      <PageCard>
        <div style={sectionTitleStyle}>{t('workflow.field.script')}</div>
        <WorkflowGraph def={def} />
        <div style={readonlyHintStyle}>
          {t('workflow.field.script.hint')}
          {onAmendInChat && (
            <>
              {' · '}
              <button
                style={{
                  ...ghostButtonStyle,
                  marginLeft: 4,
                  padding: '2px 8px',
                  fontSize: '11px',
                }}
                onClick={onAmendInChat}
              >
                {t('workflow.action.amendInChat')}
              </button>
            </>
          )}
        </div>
      </PageCard>
    </div>
  );
}