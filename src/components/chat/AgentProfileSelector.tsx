/**
 * AgentProfileSelector - Agent profile selection for chat sessions
 * Simplified version - users can only select, not manage agents
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, Bot } from 'lucide-react';
import {
  listAgentProfiles,
  setSessionAgentProfile,
  type AgentProfile,
} from '@/lib/agent-profile-ipc';

const EMOJI_MAP: Record<string, string> = {
  'general-purpose': '\ud83e\udd16',
  'code-expert': '\ud83d\udcbb',
  'research': '\ud83d\udd2c',
  'explore': '\ud83d\udd0d',
  'plan': '\ud83d\udcd6',
};

interface AgentProfileSelectorProps {
  sessionId: string | null;
  currentProfileId?: string | null;
  onProfileChange?: (profileId: string | null) => void;
}

export function AgentProfileSelector({
  sessionId,
  currentProfileId,
  onProfileChange,
}: AgentProfileSelectorProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const data = await listAgentProfiles();
      setProfiles(data);
    } catch (error) {
      console.error('[AgentProfileSelector] Failed to load profiles:', error);
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentProfile = profiles.find((p) => p.id === currentProfileId);

  const handleSelect = async (profileId: string | null) => {
    if (!sessionId) return;
    setIsLoading(true);
    try {
      await setSessionAgentProfile(sessionId, profileId);
      onProfileChange?.(profileId);
    } catch (error) {
      console.error('[AgentProfileSelector] Failed to set profile:', error);
    } finally {
      setIsLoading(false);
      setIsOpen(false);
    }
  };

  // Only show enabled profiles, presets first
  const enabledProfiles = profiles
    .filter((p) => p.isEnabled)
    .sort((a, b) => {
      if (a.isPreset !== b.isPreset) return a.isPreset ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading || !sessionId}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium
          bg-[var(--bg-tertiary)] text-[var(--text-secondary)]
          hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
        title={currentProfile?.description || 'Select agent profile'}
      >
        <Bot className="w-3.5 h-3.5" />
        <span className="max-w-[120px] truncate">
          {currentProfile?.name || 'Default Agent'}
        </span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 w-56 rounded-lg shadow-lg border
            bg-[var(--bg-primary)] border-[var(--border-color)] z-50"
        >
          <div className="p-1.5">
            {/* Default option */}
            <button
              onClick={() => handleSelect(null)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs
                ${!currentProfileId ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
            >
              <Bot className="w-3.5 h-3.5" />
              <span className="flex-1 text-left">Default Agent</span>
              {!currentProfileId && <span className="text-[10px]">Active</span>}
            </button>

            <div className="my-1 border-t border-[var(--border-color)]" />

            {/* Profile list */}
            {enabledProfiles.map((profile) => (
              <button
                key={profile.id}
                onClick={() => handleSelect(profile.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs
                  ${currentProfileId === profile.id ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
                title={profile.description || ''}
              >
                <span className="text-sm">{EMOJI_MAP[profile.id] || '🤖'}</span>
                <span className="flex-1 text-left truncate">{profile.name}</span>
                {currentProfileId === profile.id && (
                  <span className="text-[10px]">Active</span>
                )}
              </button>
            ))}

            {enabledProfiles.length === 0 && (
              <div className="px-2 py-2 text-xs text-[var(--text-muted)] text-center">
                No enabled profiles
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
