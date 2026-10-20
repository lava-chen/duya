import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '@/hooks/useTranslation';

/**
 * MacPermissionsCard — macOS TCC onboarding for the computer-use stack
 * (plan 572 Phase 1). Rendered inside the Automation page on darwin
 * only; hidden entirely elsewhere.
 *
 * The card reads the live TCC snapshot from the AX helper and deep-links
 * the matching System Settings pane. Guidance text is explicit about
 * the two macOS quirks the plan calls out: the OS dialog grants
 * nothing by itself (the pane toggle is the grant), and Screen
 * Recording needs a full app restart to take effect.
 */

interface PermissionsSnapshot {
  platform: string;
  helperAvailable: boolean;
  accessibility: 'granted' | 'denied' | 'not-determined' | 'unknown';
  screen: 'granted' | 'denied' | 'not-determined' | 'unknown';
  listen: 'granted' | 'denied' | 'not-determined' | 'unknown';
  secureInputPid: number | null;
}

type PermissionKey = 'accessibility' | 'screen' | 'listen';

const PERMISSION_ROWS: Array<{ key: PermissionKey; title: string; detail: string }> = [
  {
    key: 'accessibility',
    title: '辅助功能（Accessibility）',
    detail: '读取窗口元素树、执行按钮点击与后台键盘注入。计算机使用的核心权限。',
  },
  {
    key: 'screen',
    title: '屏幕录制（Screen Recording）',
    detail: '截取屏幕与窗口标题。授权后需要完全重启应用才会生效。',
  },
  {
    key: 'listen',
    title: '输入监控（Input Monitoring）',
    detail: '录制会话监听全局键盘事件（事件级录制通道）。',
  },
];

function stateTone(state: PermissionsSnapshot[PermissionKey]): { label: string; className: string } {
  if (state === 'granted') {
    return { label: '已授权', className: 'text-[var(--accent)]' };
  }
  if (state === 'unknown') {
    return { label: '未知', className: 'text-[var(--text-secondary)]' };
  }
  return { label: '未授权', className: 'text-[var(--text-warning)]' };
}

export function MacPermissionsCard() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null);
  const [helperMissing, setHelperMissing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const api = (window as unknown as { electronAPI?: { computerUsePermissions?: {
        get: () => Promise<PermissionsSnapshot>;
      } } }).electronAPI;
      if (!api?.computerUsePermissions) return;
      const snap = await api.computerUsePermissions.get();
      setSnapshot(snap);
      setHelperMissing(!snap.helperAvailable);
    } catch {
      setHelperMissing(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openPane = useCallback(async (pane: PermissionKey) => {
    const api = (window as unknown as { electronAPI?: { computerUsePermissions?: {
      openPane: (pane: PermissionKey) => Promise<boolean>;
    } } }).electronAPI;
    await api?.computerUsePermissions?.openPane(pane);
  }, []);

  if (!snapshot || snapshot.platform !== 'darwin') {
    return null;
  }

  const allGranted =
    snapshot.accessibility === 'granted' && snapshot.screen === 'granted' && snapshot.listen === 'granted';

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 text-sm" data-testid="mac-permissions-card">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">{t('macPermissions.title')}</span>
        <button
          type="button"
          className="text-xs text-[var(--text-secondary)] hover:text-[var(--text)]"
          onClick={() => void refresh()}
        >
          {t('macPermissions.refresh')}
        </button>
      </div>
      {helperMissing ? (
        <p className="text-[var(--text-secondary)]">{t('macPermissions.helperMissing')}</p>
      ) : (
        <>
          <ul className="space-y-2">
            {PERMISSION_ROWS.map((row) => {
              const tone = stateTone(snapshot[row.key]);
              return (
                <li key={row.key} className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{row.title}</div>
                    <div className="text-xs text-[var(--text-secondary)]">{row.detail}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`text-xs font-medium ${tone.className}`}>{tone.label}</span>
                    {snapshot[row.key] !== 'granted' && (
                      <button
                        type="button"
                        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-hover)]"
                        onClick={() => void openPane(row.key)}
                      >
                        {t('macPermissions.openSettings')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {!allGranted && (
            <p className="mt-2 text-xs text-[var(--text-secondary)]">{t('macPermissions.grantHint')}</p>
          )}
        </>
      )}
    </div>
  );
}
