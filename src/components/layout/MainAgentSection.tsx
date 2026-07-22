// src/components/layout/MainAgentSection.tsx
// Single-line "Main Agent" row in the TaskDrawer that opens the
// existing AgentProfileSelector dropdown when clicked. Selecting a
// profile writes back via setSessionAgentProfile IPC; the top-bar
// AgentModeSelector is intentionally NOT in sync with this state
// (see exec-plan: independent entry points during this refactor).

'use client';

import { AgentProfileSelector } from '@/components/chat/AgentProfileSelector';
import { DrawerSection } from './DrawerSection';

export interface MainAgentSectionProps {
  sessionId: string | null;
  currentProfileId: string | null | undefined;
  onProfileChange?: (profileId: string | null) => void;
}

export function MainAgentSection({
  sessionId,
  currentProfileId,
  onProfileChange,
}: MainAgentSectionProps) {
  return (
    <DrawerSection label="Main Agent">
      <div className="px-1 py-1">
        <AgentProfileSelector
          sessionId={sessionId}
          currentProfileId={currentProfileId}
          onProfileChange={onProfileChange}
        />
      </div>
    </DrawerSection>
  );
}