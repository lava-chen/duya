'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  ChatCircleTextIcon,
  CodeIcon,
  BrainIcon,
  RobotIcon,
} from '@/components/icons';
import {
  listAgentProfiles,
  type AgentProfile,
} from '@/lib/agent-profile-ipc';
import { getAllSettingsIPC } from '@/lib/ipc-client';

export type AgentMode = 'main' | 'code' | 'plan';

export const MODE_TO_PROFILE_MAP: Record<AgentMode, string> = {
  main: 'general-purpose',
  code: 'code-expert',
  plan: 'research',
};

export const PROFILE_TO_MODE_MAP: Record<string, AgentMode> = {
  'general-purpose': 'main',
  'code-expert': 'code',
  'research': 'plan',
};

export const AGENT_ICON_MAP: Record<string, React.ElementType> = {
  'general-purpose': ChatCircleTextIcon,
  'code-expert': CodeIcon,
  'research': BrainIcon,
  'explore': RobotIcon,
  'plan': RobotIcon,
};

export const FALLBACK_AGENT_ICON = RobotIcon;

export function getIconForProfile(profileId: string): React.ElementType {
  return AGENT_ICON_MAP[profileId] || FALLBACK_AGENT_ICON;
}

interface DynamicModeConfig {
  id: string;
  label: string;
  icon: React.ElementType;
  description: string;
  profileId: string;
}

interface AgentModeSelectorProps {
  value: AgentMode;
  onChange: (mode: AgentMode) => void;
  disabled?: boolean;
}

export function AgentModeSelector({ value, onChange, disabled = false }: AgentModeSelectorProps) {
  const [modes, setModes] = useState<DynamicModeConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadFavoriteModes() {
      try {
        const raw = await getAllSettingsIPC();
        let favoriteIds: string[] = ['general-purpose', 'code-expert', 'research'];
        if (raw.favoriteAgentIds) {
          try {
            favoriteIds = JSON.parse(raw.favoriteAgentIds);
          } catch {
            // Use defaults
          }
        }

        const profiles = await listAgentProfiles();
        const profileMap = new Map(profiles.map((p) => [p.id, p]));

        const dynamicModes: DynamicModeConfig[] = favoriteIds
          .slice(0, 3)
          .map((profileId, index) => {
            const profile = profileMap.get(profileId);
            const legacyMode = PROFILE_TO_MODE_MAP[profileId];
            return {
              id: legacyMode || `slot-${index}`,
              label: profile?.name || profileId,
              icon: getIconForProfile(profileId),
              description: profile?.description || '',
              profileId,
            };
          });

        if (isMounted) {
          setModes(dynamicModes);
        }
      } catch (err) {
        console.error('[AgentModeSelector] Failed to load favorites:', err);
        if (isMounted) {
          setModes([
            { id: 'main', label: 'General', icon: ChatCircleTextIcon, description: 'General purpose assistant', profileId: 'general-purpose' },
            { id: 'code', label: 'Code', icon: CodeIcon, description: 'Code development', profileId: 'code-expert' },
            { id: 'plan', label: 'Research', icon: BrainIcon, description: 'Research and analysis', profileId: 'research' },
          ]);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadFavoriteModes();
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    const handleStorageChange = () => {
      window.dispatchEvent(new CustomEvent('duya-settings-changed'));
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const handleClick = useCallback((modeId: string, profileId: string) => {
    const legacyMode = PROFILE_TO_MODE_MAP[profileId];
    if (legacyMode) {
      onChange(legacyMode);
    } else {
      onChange('main');
    }
  }, [onChange]);

  if (loading || modes.length === 0) {
    return (
      <div
        className="inline-flex items-center gap-0.5 rounded-lg p-0.5"
        style={{
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--border)',
        }}
      >
        <div className="px-2 py-1 text-xs text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg p-0.5"
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
    >
      {modes.map((mode) => {
        const isActive = value === mode.id;
        const Icon = mode.icon;

        return (
          <button
            key={mode.profileId}
            type="button"
            disabled={disabled}
            onClick={() => handleClick(mode.id, mode.profileId)}
            className="relative flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              color: isActive ? 'var(--accent)' : 'var(--muted)',
            }}
            title={mode.description}
          >
            {isActive && (
              <motion.div
                layoutId="agent-mode-active"
                className="absolute inset-0 rounded-md"
                style={{
                  backgroundColor: 'var(--accent-soft)',
                }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1">
              <Icon size={12} stroke={isActive ? 2.5 : 1.5} />
              <span>{mode.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function getProfileIdForMode(mode: AgentMode): string {
  return MODE_TO_PROFILE_MAP[mode];
}

export function getModeForProfileId(profileId: string | null): AgentMode | null {
  if (!profileId) return 'main';
  return PROFILE_TO_MODE_MAP[profileId] || null;
}

export default AgentModeSelector;
