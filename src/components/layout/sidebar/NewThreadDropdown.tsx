"use client";

import { useCallback } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { PlusIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

export function NewThreadDropdown() {
  const { t } = useTranslation();
  const { startNewChat } = useConversationStore();

  // Lazy creation: the button only opens the empty composer (no real thread).
  // The thread is created and shown in the sidebar only after the user
  // actually sends a message, so an unsent draft never clogs the sidebar.
  const handleNewThread = useCallback(() => {
    startNewChat();
  }, [startNewChat]);

  return (
    <button
      type="button"
      className="sidebar-primary-link"
      onClick={handleNewThread}
    >
      <span className="nav-icon">
        <PlusIcon size={16} />
      </span>
      <span>{t('nav.newChat')}</span>
    </button>
  );
}
