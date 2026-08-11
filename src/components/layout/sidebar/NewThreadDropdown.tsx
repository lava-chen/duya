"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { PlusIcon, CaretDownIcon, NotePencilIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

export function NewThreadDropdown() {
  const { t } = useTranslation();
  const { createThread, setActiveThread, startNewChat } = useConversationStore();
  const [isCreating, setIsCreating] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Main "new chat" button uses lazy creation: it only opens the empty
  // composer (no real thread). The thread is created and shown in the
  // sidebar only after the user actually sends a message, so an unsent
  // draft never clogs the sidebar.
  const handleNewThread = useCallback(() => {
    startNewChat();
  }, [startNewChat]);

  const handleNewNoProjectThread = useCallback(async () => {
    setIsMenuOpen(false);
    setIsCreating(true);
    try {
      const thread = await createThread({ noProject: true });
      if (thread) {
        setActiveThread(thread.id);
      }
    } catch (error) {
      console.error("[NewThreadDropdown] Failed to create no-project thread:", error);
    } finally {
      setIsCreating(false);
    }
  }, [createThread, setActiveThread]);

  // Close menu on click outside
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMenuOpen]);

  return (
    <div className="new-thread-dropdown" ref={menuRef}>
      <button
        type="button"
        className="sidebar-primary-link new-thread-btn"
        onClick={handleNewThread}
        disabled={isCreating}
      >
        <span className="nav-icon">
          <PlusIcon size={16} />
        </span>
        <span>{t('nav.newChat')}</span>
      </button>
      <button
        type="button"
        className="new-thread-caret"
        onClick={() => setIsMenuOpen((v) => !v)}
        disabled={isCreating}
        aria-label={t('project.options')}
        aria-expanded={isMenuOpen}
      >
        <CaretDownIcon size={14} />
      </button>
      {isMenuOpen && (
        <div className="project-dropdown-menu new-thread-menu">
          <button
            type="button"
            className="project-dropdown-item"
            onClick={handleNewNoProjectThread}
          >
            <NotePencilIcon size={14} />
            <span>{t('project.newNoProjectSession')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
