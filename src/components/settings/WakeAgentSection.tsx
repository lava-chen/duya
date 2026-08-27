'use client';

/**
 * WakeAgentSection — settings page card for Wake Agent.
 *
 * Plan 453 Task H. The card exposes the [wake] config section
 * (config.toml) to the user:
 *   - enabled        : total on/off switch
 *   - shortcut       : Electron globalShortcut string
 *   - injectOsContext: pass OSContext into the first user turn
 *   - autoCollapseMs : fold INPUT/RESULT after this much idle time
 *
 * Persists via the existing settings IPC bridge (no new wiring).
 *
 * Translations: i18n keys (`settings.wake.*`) are added in a follow-up
 * commit; for now the strings are hardcoded so the file type-checks
 * under the strict i18n key registry.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
} from '@/components/settings/ui';

interface WakeConfig {
  enabled: boolean;
  shortcut: string;
  injectOsContext: boolean;
  autoCollapseMs: number;
  orb: { x: number; y: number; displayId: number };
}

const DEFAULT_CONFIG: WakeConfig = {
  enabled: true,
  shortcut: 'CommandOrControl+Shift+Space',
  injectOsContext: true,
  autoCollapseMs: 60_000,
  orb: { x: 100, y: 100, displayId: 0 },
};

export function WakeAgentSection() {
  const [config, setConfig] = useState<WakeConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const api = window.electronAPI?.settings;
        if (!api?.getWakeConfig) {
          setLoaded(true);
          return;
        }
        const cfg = await api.getWakeConfig();
        if (cancelled) return;
        setConfig({ ...DEFAULT_CONFIG, ...cfg });
        setLoaded(true);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (patch: Partial<WakeConfig>) => {
      const next = { ...config, ...patch };
      setConfig(next);
      setSaving(true);
      setError(null);
      try {
        const api = window.electronAPI?.settings;
        if (api?.setWakeConfig) {
          await api.setWakeConfig(patch);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [config],
  );

  if (!loaded) {
    return (
      <SettingsSection
        title="Wake Agent"
        description="Globally hotkey + OS context"
      >
        <SettingsCard>
          <SettingsRow label="Loading">
            <span />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Wake Agent"
      description="Wake Agent global hotkey + OS context injection"
    >
      <SettingsCard>
        <SettingsToggle
          label="Enable Wake Agent"
          description="Ctrl+Shift+Space opens the floating orb; first user turn carries OS context."
          checked={config.enabled}
          disabled={saving}
          onCheckedChange={(v: boolean) => void save({ enabled: v })}
        />

        <SettingsInput
          label="Global shortcut"
          description="Electron globalShortcut string. Empty falls back to Ctrl+Shift+Space."
          value={config.shortcut}
          placeholder="CommandOrControl+Shift+Space"
          disabled={saving}
          onChange={(value: string) => void save({ shortcut: value })}
        />

        <SettingsToggle
          label="Inject OS context"
          description="First user message includes the <external_os_context> block so the LLM pre-grounds its reply."
          checked={config.injectOsContext}
          disabled={saving}
          onCheckedChange={(v: boolean) => void save({ injectOsContext: v })}
        />

        <SettingsInput
          label="Auto-collapse input/result (ms)"
          description="Fold the input box / result card after this many ms of no keyboard / mouse activity (the ball itself never collapses)."
          value={String(config.autoCollapseMs)}
          placeholder="60000"
          disabled={saving}
          onChange={(value: string) => {
            const n = Number.parseInt(value, 10);
            if (Number.isFinite(n) && n >= 0) {
              void save({ autoCollapseMs: n });
            }
          }}
        />
      </SettingsCard>

      {error && (
        <SettingsCard>
          <SettingsRow label="Save failed" description={error} />
        </SettingsCard>
      )}
    </SettingsSection>
  );
}