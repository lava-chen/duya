'use client';

import { useEffect, useState } from 'react';
import { getIconForProfile } from './AgentModeSelector';
import { listAgentProfiles } from '@/lib/agent-profile-ipc';

// Fallback names for presets before the profile list resolves (or if the
// profile is not found). Mirrors the names used by the new-session picker.
const FALLBACK_NAMES: Record<string, string> = {
  'general-purpose': 'Main',
  'code-expert': 'Code',
  'research': 'Deep Research',
  'explore': 'Explore',
  'plan': 'Plan',
};

interface AgentProfileBadgeProps {
  profileId: string | null;
}

/**
 * Read-only agent profile badge. The profile is fixed at session creation
 * (per plan 2026-08-12), so this replaces the old in-session switcher with a
 * passive indicator mirroring the session's bound `agent_profile_id`.
 */
export function AgentProfileBadge({ profileId }: AgentProfileBadgeProps) {
  const resolvedId = profileId ?? 'general-purpose';
  const [name, setName] = useState<string>(FALLBACK_NAMES[resolvedId] ?? resolvedId);
  const [desc, setDesc] = useState<string | undefined>(undefined);

  useEffect(() => {
    let isMounted = true;
    listAgentProfiles()
      .then((profiles) => {
        const profile = profiles.find((p) => p.id === resolvedId);
        if (isMounted && profile) {
          setName(profile.name);
          setDesc(profile.description);
        }
      })
      .catch(() => {
        // Keep the fallback name if the profile list cannot be loaded.
      });
    return () => {
      isMounted = false;
    };
  }, [resolvedId]);

  const Icon = getIconForProfile(resolvedId);

  return (
    <div
      className="agent-profile-badge inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium"
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        color: 'var(--muted)',
      }}
      title={desc ?? resolvedId}
    >
      <Icon size={12} />
      <span className="truncate">{name}</span>
    </div>
  );
}

export default AgentProfileBadge;