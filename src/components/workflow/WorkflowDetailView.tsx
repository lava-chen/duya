/**
 * WorkflowDetailView — full-screen definition detail page (plan 552 Phase 9).
 *
 * Layout:
 *
 *   repo-overview                                     [▶ 运行] [⋯]
 *   并行调研任意仓库（…），汇总成一份给新接手者看的项目速览报告
 *
 *   [定义] [运行历史]        ~/.duya/workflows/repo-overview.dwf.ts  [copy]
 *
 *   基本信息
 *     说明      ┌────────────────────────────┐
 *               │ <description>              │   ← frontmatter (editable)
 *               └────────────────────────────┘
 *     使用时机  ┌────────────────────────────┐
 *     参数      名称 / 类型 / 必填 / 默认值 / 说明  + 添加参数
 *   脚本       read-only — node graph, else the .dwf.ts body
 *
 * Two write surfaces, deliberately separated:
 *   • 基本信息 is the frontmatter editor. Saving rewrites only the header
 *     block; the script body is round-tripped byte-for-byte.
 *   • 脚本 is read-only. Script edits go through the agent, which is what the
 *     ⋯ → 「在对话里和 agent 修改」 menu item sets up: it opens a dialog that
 *     pins the workflow skill + this file's absolute path, appends the user's
 *     own requirements, and starts a new chat draft with the composed prompt.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useTheme } from '@/hooks/useTheme';
import {
  PlayIcon,
  CopyIcon,
  CheckIcon,
  DotsThreeIcon,
  IconRefresh,
  RepeatIcon,
  PlusIcon,
  XIcon,
  ChatCircleIcon,
  FileCodeIcon,
  SpinnerGapIcon,
  WarningIcon,
  ArrowLeftIcon,
} from '@/components/icons';
import { PageFrame, PageCard, EmptyState, Modal } from '@/components/ui/page';
import { AutoResizeTextarea } from '@/components/ui/AutoResizeTextarea';
import { Switch } from '@/components/ui/Switch';
import { DropdownMenu, type MenuAction } from '@/components/ui/DropdownMenu';
import { toast } from '@/components/ui/toast';
import { SyntaxHighlighter } from '@/lib/prism-languages';
import { vs, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { WorkflowGraph } from './WorkflowGraph';
import { WorkflowPreviewCard } from './run-display/workflow-preview-card';
import { RunsTab } from '@/components/layout/panels/WorkflowPanel';
import {
  WorkflowLaunchDialog,
  type WorkflowLaunchDialogEntry,
} from '@/components/workflow/WorkflowLaunchDialog';
import {
  getWorkflowDwfDetailIPC,
  saveDwfWorkflowIPC,
  type WorkflowDefinitionSummary,
  type DwfArgDeclaration,
  type DwfMeta,
} from '@/lib/workflow-ipc';
import { useConversationStore } from '@/stores/conversation-store';
import type {
  WorkflowDefView,
  WorkflowNodeView,
  WorkflowParamView,
  WorkflowPhaseView,
} from '@/lib/workflow-types';
import { deriveNodeKind } from '@/lib/workflow-types';

// ─── styles ────────────────────────────────────────────────────────────────

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--space-4, 16px)',
  marginBottom: 'var(--space-3, 12px)',
};

const titleBlockStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const titleStyle: CSSProperties = {
  fontSize: '18px',
  fontWeight: 600,
  lineHeight: 1.3,
  color: 'var(--text)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  wordBreak: 'break-word',
};

const descriptionStyle: CSSProperties = {
  fontSize: '13px',
  lineHeight: 1.6,
  color: 'var(--muted)',
  maxWidth: '820px',
};

const actionGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2, 8px)',
  flexShrink: 0,
};

const runButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '7px 14px',
  background: 'var(--surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  height: '32px',
  padding: 0,
  background: 'transparent',
  color: 'var(--muted)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  cursor: 'pointer',
  flexShrink: 0,
};

/** Tabs on the left, the definition's file path on the right. */
const tabsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3, 12px)',
  marginBottom: 'var(--space-4, 16px)',
};

const tabGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '2px',
  flexShrink: 0,
};

const tabStyle = (active: boolean): CSSProperties => ({
  padding: '5px 12px',
  fontSize: '13px',
  fontWeight: active ? 500 : 400,
  color: active ? 'var(--text)' : 'var(--muted)',
  background: active ? 'var(--surface)' : 'transparent',
  border: 'none',
  borderRadius: '7px',
  cursor: 'pointer',
});

const pathInlineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  minWidth: 0,
  maxWidth: '52%',
};

const pathTextStyle: CSSProperties = {
  fontSize: '12px',
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const sectionsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-5, 20px)',
};

const sectionLabelStyle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--muted)',
  letterSpacing: '0.02em',
};

const sectionHeaderRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-3, 12px)',
};

const fieldBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const fieldLabelStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text)',
};

const hintStyle: CSSProperties = {
  fontSize: '12px',
  lineHeight: 1.5,
  color: 'var(--muted)',
};

const paramsTableStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '10px',
  overflow: 'hidden',
};

const paramGridColumns = 'minmax(120px, 1fr) 116px 64px minmax(110px, 1fr) minmax(150px, 1.5fr) 40px';

const paramsHeadStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: paramGridColumns,
  alignItems: 'center',
  gap: '10px',
  padding: '8px 12px',
  background: 'var(--surface)',
  borderBottom: '1px solid var(--border)',
  fontSize: '12px',
  color: 'var(--muted)',
};

const paramRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: paramGridColumns,
  alignItems: 'center',
  gap: '10px',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
};

const paramInputStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '6px 9px',
  borderRadius: '7px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  fontSize: '12px',
  fontFamily: 'inherit',
};

const addParamRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  padding: '9px 12px',
  background: 'transparent',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '12px',
  cursor: 'pointer',
  textAlign: 'left',
  gap: '6px',
};

const deleteParamStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '26px',
  height: '26px',
  padding: 0,
  background: 'transparent',
  color: 'var(--muted)',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  justifySelf: 'center',
};

const scriptHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-2, 8px)',
  padding: '7px 12px',
  background: 'var(--surface)',
  borderBottom: '1px solid var(--border)',
  fontSize: '12px',
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
};

const scriptBoxStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '10px',
  overflow: 'hidden',
  background: 'var(--surface)',
};

const scriptBodyStyle: CSSProperties = {
  margin: 0,
  padding: '12px',
  fontSize: '12px',
  lineHeight: 1.65,
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  overflow: 'auto',
  maxHeight: '520px',
  background: 'transparent',
};

const dirtyBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '12px',
  color: 'var(--muted)',
};

const dialogPromptStyle: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  borderRadius: '8px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--muted)',
  fontSize: '12px',
  lineHeight: 1.6,
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: '168px',
  overflow: 'auto',
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
    script: typeof r.script === 'string' ? r.script : undefined,
  };
}

// ─── frontmatter draft (the 基本信息 editor's state) ────────────────────────

type ParamType = NonNullable<DwfArgDeclaration['type']>;

const PARAM_TYPES: ParamType[] = ['string', 'number', 'boolean', 'json'];

/** Mirrors the agent-side `SAVED_WORKFLOW_NAME_PATTERN`. */
const ARG_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

interface ParamDraft {
  /** Stable React key — the name is editable, so it cannot be the key. */
  key: string;
  name: string;
  type: ParamType;
  required: boolean;
  /** Raw text; parsed per `type` on save. */
  defaultText: string;
  description: string;
}

interface MetaDraft {
  description: string;
  whenToUse: string;
  args: ParamDraft[];
}

function serializeDefault(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Text → the declared type. `undefined` means "no default". */
function parseDefaultValue(text: string, type: ParamType): unknown {
  const raw = text.trim();
  if (raw === '') return undefined;
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined;
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return text;
  }
}

function argsToDrafts(args: DwfMeta['args'] | undefined, seed: string): ParamDraft[] {
  if (!args) return [];
  return Object.entries(args).map(([name, spec], index) => ({
    key: `${seed}-${index}-${name}`,
    name,
    type: (spec?.type ?? 'string') as ParamType,
    required: spec?.required === true,
    defaultText: serializeDefault(spec?.default),
    description: spec?.description ?? '',
  }));
}

/** Draft → the `args` record, dropping unnamed rows. */
function draftsToArgs(drafts: ParamDraft[]): Record<string, DwfArgDeclaration> | undefined {
  const args: Record<string, DwfArgDeclaration> = {};
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const decl: DwfArgDeclaration = { type: draft.type };
    if (draft.description.trim()) decl.description = draft.description.trim();
    if (draft.required) decl.required = true;
    const value = parseDefaultValue(draft.defaultText, draft.type);
    if (value !== undefined) decl.default = value;
    args[name] = decl;
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

function metaToDraft(meta: DwfMeta | null, name: string): MetaDraft {
  return {
    description: meta?.description ?? '',
    whenToUse: meta?.whenToUse ?? '',
    args: argsToDrafts(meta?.args, name),
  };
}

/** Stable comparison key for dirty tracking / run params. */
function draftSignature(draft: MetaDraft): string {
  return JSON.stringify({
    description: draft.description,
    whenToUse: draft.whenToUse,
    args: draftsToArgs(draft.args) ?? null,
  });
}

/**
 * Prompt for the ⋯ → 「在对话里和 agent 修改」 route. It pins the skill and the
 * file path (the agent must not guess which definition it is amending) and
 * leaves every judgement call to the skill and to the user's own text.
 */
function buildAmendPrompt(filePath: string, requirements: string): string {
  return [
    '请修改一个已保存的 duya 工作流定义（.dwf.ts）。',
    '',
    `工作流文件：${filePath}`,
    '（文件顶部是元数据块 description / whenToUse / args，之前之后是脚本正文；脚本正文是权威源）',
    '',
    '请先加载 dynamic-workflow skill，按它的规范理解并修订这个工作流；',
    '直接改写上面这个文件（除非我另有要求，不要另存新文件），改完说明改了什么、脚本是否仍能通过校验。',
    '',
    '我的修改要求：',
    requirements.trim(),
  ].join('\n');
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// ─── component ─────────────────────────────────────────────────────────────

export interface WorkflowDetailViewProps {
  name: string;
  scope?: 'global' | 'project';
  /** Path to navigate back to the library. */
  onBack: () => void;
  projectDir?: string;
  /**
   * Open a chat session pre-filled with a prompt to amend this workflow.
   * When omitted, the detail view starts the session itself (a new chat
   * draft carrying the composed prompt).
   */
  onAmendInChat?: (name: string, scope: 'global' | 'project', requirements: string) => void;
}

type TabKey = 'definition' | 'history';

export function WorkflowDetailView({
  name,
  scope = 'global',
  onBack,
  projectDir,
  onAmendInChat,
}: WorkflowDetailViewProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('definition');
  const [def, setDef] = useState<WorkflowDefView | null>(null);
  const [summary, setSummary] = useState<WorkflowDefinitionSummary | null>(null);
  const [resolvedScope, setResolvedScope] = useState<'global' | 'project'>(scope);
  const [draft, setDraft] = useState<MetaDraft>(() => metaToDraft(null, name));
  const [savedSignature, setSavedSignature] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'path' | 'script' | null>(null);
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendText, setAmendText] = useState('');
  const [amendError, setAmendError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getWorkflowDwfDetailIPC({ name, projectDir });
      if (!res) {
        setError('not_found');
        setDef(null);
        return;
      }
      const nextDraft = metaToDraft(res.meta ?? null, name);
      setSummary(res.summary ?? null);
      setDef(coerceDef(res.definition));
      setResolvedScope(res.resolvedScope ?? scope);
      setDraft(nextDraft);
      setSavedSignature(draftSignature(nextDraft));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDef(null);
    } finally {
      setLoading(false);
    }
  }, [name, projectDir, scope]);

  useEffect(() => {
    reload();
  }, [reload]);

  const filePath = summary?.file ?? `~/.duya/workflows/${name}.dwf.ts`;
  const scopeLabel = resolvedScope === 'project' ? t('workflow.scopeProject') : t('workflow.scopeGlobal');

  const dirty = !loading && savedSignature !== '' && draftSignature(draft) !== savedSignature;

  const [launching, setLaunching] = useState(false);

  /**
   * Plan 560 §7.5: ▶ opens the 实参窗 instead of firing immediately. Under the
   * run anchor the working directory is mandatory (it is the agent nodes'
   * workingDirectory), so it can no longer be inherited silently from whatever
   * session happened to be open.
   */
  const launchEntry = useMemo<WorkflowLaunchDialogEntry>(
    () => ({
      name,
      description: draft.description.trim() || undefined,
      scope: resolvedScope,
      args: draftsToArgs(draft.args) ?? undefined,
      // Lets the launch dialog default the run location to this file's
      // owning project (before the user's remembered choice).
      path: summary?.file,
    }),
    [name, resolvedScope, draft.description, draft.args, summary?.file],
  );

  const handleRun = useCallback(() => {
    setLaunching(true);
  }, []);

  const handleSave = useCallback(async () => {
    const description = draft.description.trim();
    if (!description) {
      toast({ variant: 'warning', title: t('workflow.save.needDescription') });
      return;
    }
    // Without the loaded body a save would overwrite the script with ''.
    if (!def) {
      toast({ variant: 'error', title: t('workflow.save.failed') });
      return;
    }
    setSaving(true);
    try {
      const args = draftsToArgs(draft.args);
      const nextMeta = {
        description,
        ...(draft.whenToUse.trim() ? { whenToUse: draft.whenToUse.trim() } : {}),
        ...(args ? { args } : {}),
      };
      const res = await saveDwfWorkflowIPC({
        name,
        meta: nextMeta,
        // The script body is round-tripped verbatim: the viewer never edits it.
        script: def.script ?? '',
        scope: resolvedScope,
        projectDir,
      });
      if (!res?.ok) {
        toast({
          variant: 'error',
          title: t('workflow.save.failed'),
          description: res?.error,
        });
        return;
      }
      setSavedSignature(draftSignature(draft));
      toast({
        variant: 'success',
        title: t('workflow.action.saved'),
        description: res.file ? t('workflow.save.ok', { path: res.file }) : undefined,
      });
      if (res.file) setSummary((prev) => (prev ? { ...prev, file: res.file } : prev));
    } finally {
      setSaving(false);
    }
  }, [draft, name, resolvedScope, projectDir, def, t]);

  const copy = useCallback(async (text: string, which: 'path' | 'script') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied((prev) => (prev === which ? null : prev)), 1500);
    } catch {
      /* clipboard unavailable — leave the button state alone */
    }
  }, []);

  const amendPrefix = useMemo(
    () => buildAmendPrompt(filePath, '').trimEnd(),
    [filePath],
  );

  const handleAmendConfirm = useCallback(() => {
    const requirements = amendText.trim();
    if (!requirements) {
      setAmendError(t('workflow.amend.needInput'));
      return;
    }
    setAmendError(null);
    setAmendOpen(false);
    setAmendText('');

    if (onAmendInChat) {
      onAmendInChat(name, resolvedScope, requirements);
      return;
    }

    // Default route: start a new chat draft pinned to this project (when we
    // have one) so the agent reads the definition in the right workspace. The
    // thread is created by the standard new-chat pipeline on send.
    const store = useConversationStore.getState();
    store.startNewChat(
      projectDir
        ? { workingDirectory: projectDir, projectName: fileNameOf(projectDir) }
        : null,
    );
    store.updateNewChatDraft({
      text: buildAmendPrompt(filePath, requirements),
      attachments: [],
      hasContent: true,
    });
  }, [amendText, onAmendInChat, name, resolvedScope, projectDir, filePath, t]);

  const menuItems: MenuAction[] = [
    {
      kind: 'action',
      id: 'amend-in-chat',
      label: t('workflow.action.amendInChat'),
      iconLeft: <ChatCircleIcon size={14} />,
      onSelect: () => setAmendOpen(true),
    },
    {
      kind: 'action',
      id: 'copy-path',
      label: t('panel.workflow.copyPath'),
      iconLeft: <CopyIcon size={14} />,
      onSelect: () => void copy(filePath, 'path'),
    },
  ];

  return (
    <PageFrame>
      {/* Title (no icon) + description, actions on the right */}
      <div style={headerRowStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0, flex: 1 }}>
          <button
            type="button"
            className="wf-detail-ghost"
            style={{ ...iconButtonStyle, marginTop: '1px' }}
            onClick={onBack}
            aria-label={t('workflow.action.back')}
            title={t('workflow.action.back')}
          >
            <ArrowLeftIcon size={14} />
          </button>
          <div style={titleBlockStyle}>
            <div style={titleStyle}>{name}</div>
            {def?.description ? <div style={descriptionStyle}>{def.description}</div> : null}
          </div>
        </div>
        <div style={actionGroupStyle}>
          <button
            type="button"
            className="wf-detail-ghost"
            style={iconButtonStyle}
            onClick={reload}
            aria-label={t('panel.workflow.refresh')}
            title={t('panel.workflow.refresh')}
          >
            <IconRefresh size={14} />
          </button>
          {dirty ? (
            <button
              type="button"
              className="wf-detail-ghost"
              style={iconButtonStyle}
              onClick={handleSave}
              disabled={saving}
              aria-label={t('workflow.action.save')}
              title={t('workflow.action.unsaved')}
            >
              {saving ? <SpinnerGapIcon size={14} /> : <CheckIcon size={14} />}
            </button>
          ) : null}
          <button type="button" className="wf-detail-run" style={runButtonStyle} onClick={handleRun}>
            <PlayIcon size={13} />
            {t('workflow.action.run')}
          </button>
          <DropdownMenu
            trigger={
              <button
                type="button"
                className="wf-detail-ghost"
                style={iconButtonStyle}
                aria-label="more"
              >
                <DotsThreeIcon size={16} />
              </button>
            }
            items={menuItems}
            align="end"
            minWidth={220}
          />
        </div>
      </div>

      {/* Tabs (left) + file path (right) */}
      <div style={tabsRowStyle}>
        <div style={tabGroupStyle} role="tablist">
          <button
            type="button"
            style={tabStyle(tab === 'definition')}
            onClick={() => setTab('definition')}
            role="tab"
            aria-selected={tab === 'definition'}
          >
            {t('workflow.tab.definition')}
          </button>
          <button
            type="button"
            style={tabStyle(tab === 'history')}
            onClick={() => setTab('history')}
            role="tab"
            aria-selected={tab === 'history'}
          >
            {t('workflow.tab.history')}
          </button>
        </div>
        <div style={pathInlineStyle}>
          <span style={pathTextStyle} title={filePath}>
            {filePath}
          </span>
          <button
            type="button"
            className="wf-detail-ghost"
            style={{ ...iconButtonStyle, width: '24px', height: '24px', border: 'none' }}
            onClick={() => void copy(filePath, 'path')}
            aria-label={t('workflow.copy')}
            title={filePath}
          >
            {copied === 'path' ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          </button>
        </div>
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
          filePath={filePath}
          draft={draft}
          onDraftChange={setDraft}
          dirty={dirty}
          saving={saving}
          onSave={handleSave}
          loading={loading}
          copiedScript={copied === 'script'}
          onCopyScript={() => void copy(def?.script ?? '', 'script')}
        />
      )}

      {!error && tab === 'history' && (
        <div style={{ paddingTop: 'var(--space-2, 8px)' }}>
          <RunsTab />
        </div>
      )}

      <AmendInChatDialog
        open={amendOpen}
        filePath={filePath}
        scopeLabel={scopeLabel}
        prefix={amendPrefix}
        value={amendText}
        error={amendError}
        onChange={(next) => {
          setAmendText(next);
          if (amendError) setAmendError(null);
        }}
        onCancel={() => {
          setAmendOpen(false);
          setAmendError(null);
        }}
        onConfirm={handleAmendConfirm}
      />

      {launching && (
        <WorkflowLaunchDialog
          entry={launchEntry}
          defaultProjectDir={projectDir}
          onClose={() => setLaunching(false)}
          onLaunched={() => setTab('history')}
        />
      )}
    </PageFrame>
  );
}

// ─── definition tab ────────────────────────────────────────────────────────

function DefinitionTab({
  def,
  filePath,
  draft,
  onDraftChange,
  dirty,
  saving,
  onSave,
  loading,
  copiedScript,
  onCopyScript,
}: {
  def: WorkflowDefView | null;
  filePath: string;
  draft: MetaDraft;
  onDraftChange: (next: MetaDraft) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  loading: boolean;
  copiedScript: boolean;
  onCopyScript: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

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

  const patchArg = (key: string, patch: Partial<ParamDraft>) => {
    onDraftChange({
      ...draft,
      args: draft.args.map((arg) => (arg.key === key ? { ...arg, ...patch } : arg)),
    });
  };

  const hasScript = typeof def.script === 'string' && def.script.trim().length > 0;

  return (
    <div style={sectionsStyle}>
      <div style={{ ...sectionLabelStyle, display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span>{t('workflow.section.basicInfo')}</span>
        {dirty ? (
          <span style={dirtyBadgeStyle}>
            {t('workflow.action.unsaved')}
            <button
              type="button"
              className="wf-detail-ghost"
              onClick={onSave}
              disabled={saving}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                fontSize: '12px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {saving ? <SpinnerGapIcon size={12} /> : null}
              {saving ? t('workflow.action.saving') : t('workflow.action.save')}
            </button>
          </span>
        ) : null}
      </div>

      {/* 说明 */}
      <div style={fieldBlockStyle}>
        <div style={fieldLabelStyle}>{t('workflow.field.description')}</div>
        <AutoResizeTextarea
          className="wf-detail-field"
          style={fieldBoxStyle}
          value={draft.description}
          onChange={(value) => onDraftChange({ ...draft, description: value })}
          placeholder={t('workflow.field.description.placeholder')}
          minRows={2}
          maxHeight={220}
          ariaLabel={t('workflow.field.description')}
        />
      </div>

      {/* 使用时机 */}
      <div style={fieldBlockStyle}>
        <div style={fieldLabelStyle}>{t('workflow.field.whenToUse')}</div>
        <AutoResizeTextarea
          className="wf-detail-field"
          style={fieldBoxStyle}
          value={draft.whenToUse}
          onChange={(value) => onDraftChange({ ...draft, whenToUse: value })}
          placeholder={t('workflow.field.whenToUse.placeholder')}
          minRows={2}
          maxHeight={220}
          ariaLabel={t('workflow.field.whenToUse')}
        />
        <div style={hintStyle}>{t('workflow.field.whenToUse.hint')}</div>
      </div>

      {/* 参数 */}
      <div style={fieldBlockStyle}>
        <div style={fieldLabelStyle}>{t('workflow.field.parameters')}</div>
        <div style={paramsTableStyle}>
          <div style={paramsHeadStyle}>
            <span>{t('workflow.field.parameters.name')}</span>
            <span>{t('workflow.field.parameters.type')}</span>
            <span>{t('workflow.field.parameters.required')}</span>
            <span>{t('workflow.field.parameters.default')}</span>
            <span>{t('workflow.field.parameters.desc')}</span>
            <span />
          </div>

          {draft.args.map((arg) => {
            const nameInvalid = arg.name.trim() !== '' && !ARG_NAME_PATTERN.test(arg.name.trim());
            return (
              <div key={arg.key} style={paramRowStyle}>
                <input
                  className="wf-detail-field"
                  style={{
                    ...paramInputStyle,
                    ...(nameInvalid ? { borderColor: 'var(--error)' } : null),
                    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
                  }}
                  value={arg.name}
                  onChange={(event) => patchArg(arg.key, { name: event.target.value })}
                  placeholder={t('workflow.field.parameters.namePlaceholder')}
                  aria-label={t('workflow.field.parameters.name')}
                  title={nameInvalid ? t('workflow.field.parameters.nameInvalid') : arg.name}
                  spellCheck={false}
                />
                <select
                  className="wf-detail-field"
                  style={paramInputStyle}
                  value={arg.type}
                  onChange={(event) =>
                    patchArg(arg.key, { type: event.target.value as ParamType })
                  }
                  aria-label={t('workflow.field.parameters.type')}
                >
                  {PARAM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <div style={{ justifySelf: 'center' }}>
                  <Switch
                    checked={arg.required}
                    onCheckedChange={(checked) => patchArg(arg.key, { required: checked })}
                    ariaLabel={`${arg.name || t('workflow.field.parameters.name')} ${t(
                      'workflow.field.parameters.required',
                    )}`}
                  />
                </div>
                <input
                  className="wf-detail-field"
                  style={{
                    ...paramInputStyle,
                    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
                  }}
                  value={arg.defaultText}
                  onChange={(event) => patchArg(arg.key, { defaultText: event.target.value })}
                  placeholder={t('workflow.field.parameters.defaultPlaceholder')}
                  aria-label={t('workflow.field.parameters.default')}
                  spellCheck={false}
                />
                <input
                  className="wf-detail-field"
                  style={paramInputStyle}
                  value={arg.description}
                  onChange={(event) => patchArg(arg.key, { description: event.target.value })}
                  placeholder={t('workflow.field.parameters.descPlaceholder')}
                  aria-label={t('workflow.field.parameters.desc')}
                />
                <button
                  type="button"
                  className="wf-detail-ghost"
                  style={deleteParamStyle}
                  aria-label={t('workflow.field.parameters.delete')}
                  title={t('workflow.field.parameters.delete')}
                  onClick={() =>
                    onDraftChange({
                      ...draft,
                      args: draft.args.filter((item) => item.key !== arg.key),
                    })
                  }
                >
                  <XIcon size={13} />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            style={addParamRowStyle}
            onClick={() =>
              onDraftChange({
                ...draft,
                args: [
                  ...draft.args,
                  {
                    key: `new-${Date.now().toString(36)}`,
                    name: t('workflow.field.parameters.newArg'),
                    type: 'string',
                    required: false,
                    defaultText: '',
                    description: '',
                  },
                ],
              })
            }
          >
            <PlusIcon size={12} />
            {t('workflow.field.parameters.add')}
          </button>
        </div>
        <div style={hintStyle}>{t('workflow.field.parameters.editHint')}</div>
      </div>

      {/* 脚本 */}
      <div style={fieldBlockStyle}>
        <div style={sectionHeaderRowStyle}>
          <div style={fieldLabelStyle}>{t('workflow.field.script')}</div>
          <div style={hintStyle}>{t('workflow.field.script.hint')}</div>
        </div>
        {def.phases.length > 0 ? (
          <WorkflowGraph def={def} />
        ) : hasScript ? (
          <>
          {/* Static flow preview: raw .dwf.ts scripts carry no declarative
              phases, so the rail is approximated straight from the source. */}
          <WorkflowPreviewCard script={def.script ?? ''} />
          <div style={scriptBoxStyle}>
            <div style={scriptHeaderStyle}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                <FileCodeIcon size={13} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fileNameOf(filePath)} · TypeScript
                </span>
              </span>
              <button
                type="button"
                className="wf-detail-ghost"
                style={{ ...iconButtonStyle, width: '24px', height: '24px', border: 'none' }}
                onClick={onCopyScript}
                aria-label={t('workflow.copy')}
                title={t('workflow.copy')}
              >
                {copiedScript ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              </button>
            </div>
            <SyntaxHighlighter
              language="typescript"
              style={isDark ? vscDarkPlus : vs}
              customStyle={scriptBodyStyle}
              codeTagProps={{
                style: {
                  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
                },
              }}
            >
              {def.script ?? ''}
            </SyntaxHighlighter>
          </div>
          </>
        ) : (
          <div style={hintStyle}>{t('workflow.field.script.hint')}</div>
        )}
      </div>
    </div>
  );
}

// ─── amend-in-chat dialog ──────────────────────────────────────────────────

function AmendInChatDialog({
  open,
  filePath,
  scopeLabel,
  prefix,
  value,
  error,
  onChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  filePath: string;
  scopeLabel: string;
  prefix: string;
  value: string;
  error: string | null;
  onChange: (next: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    // AutoResizeTextarea owns its element ref, so focus the field by query —
    // the dialog exists so the user can start typing without a extra click.
    const timer = setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-amend-input] textarea')?.focus();
    }, 80);
    return () => clearTimeout(timer);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t('workflow.amend.title')}
      subtitle={`${scopeLabel} · ${filePath}`}
      description={t('workflow.amend.description')}
      maxWidth={620}
      footer={
        <>
          <button
            type="button"
            className="wf-detail-ghost"
            onClick={onCancel}
            style={{
              padding: '7px 14px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            {t('workflow.amend.cancel')}
          </button>
          <button
            type="button"
            className="wf-detail-run"
            onClick={onConfirm}
            style={{ ...runButtonStyle, padding: '7px 16px' }}
          >
            <ChatCircleIcon size={13} />
            {t('workflow.amend.create')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={fieldLabelStyle}>{t('workflow.amend.promptLabel')}</div>
          <pre style={dialogPromptStyle}>{prefix}</pre>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }} data-amend-input>
          <div style={fieldLabelStyle}>{t('workflow.amend.requirementsLabel')}</div>
          <AutoResizeTextarea
            className="wf-detail-field"
            style={fieldBoxStyle}
            value={value}
            onChange={onChange}
            placeholder={t('workflow.amend.requirementsPlaceholder')}
            minRows={4}
            maxHeight={220}
            ariaLabel={t('workflow.amend.requirementsLabel')}
          />
          {error ? <div style={{ ...hintStyle, color: 'var(--error)' }}>{error}</div> : null}
        </div>
      </div>
    </Modal>
  );
}

/** Boxed, borderless-looking field surface shared by every metadata editor. */
const fieldBoxStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: '10px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  fontSize: '13px',
  lineHeight: 1.6,
  fontFamily: 'inherit',
  resize: 'none',
};
