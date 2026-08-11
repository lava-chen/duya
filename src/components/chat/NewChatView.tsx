// NewChatView.tsx - Lazy new-chat composer.
//
// Unlike ChatView (which always has a backing session), this view is shown
// when the user clicks "new chat" but has NOT sent anything yet. No real
// thread is created or shown in the sidebar until the user sends. Text +
// attachments are kept in a global draft (conversation-store) that survives
// navigation and app restarts, so the user can resume an unsent draft.

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useConversationStore } from '@/stores/conversation-store';
import { getActiveProviderIPC } from '@/lib/ipc-client';
import { useTranslation } from '@/hooks/useTranslation';
import { MessageInput } from './MessageInput';
import type { PermissionMode } from './PermissionModeSelector';
import type { FileAttachment } from '@/types/message';

interface NewChatViewProps {
  onSendMessage: (
    content: string,
    permissionMode?: PermissionMode,
    model?: string,
    files?: FileAttachment[],
    agentProfileId?: string | null,
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
    mode?: string,
    effort?: string,
    displayContent?: string,
  ) => void;
}

export function NewChatView({ onSendMessage }: NewChatViewProps) {
  const { t } = useTranslation();
  const {
    newChatDraft,
    createThread,
    setActiveThread,
    updateNewChatDraft,
    clearNewChatDraft,
  } = useConversationStore();

  const [isSending, setIsSending] = useState(false);
  const [sessionModel, setSessionModel] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');

  // Refs to always read the latest values inside stable callbacks.
  const sessionModelRef = useRef(sessionModel);
  sessionModelRef.current = sessionModel;
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;
  const onSendMessageRef = useRef(onSendMessage);
  onSendMessageRef.current = onSendMessage;

  const parseModelName = useCallback((model: string): { providerName: string | null; modelName: string } => {
    const match = model.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      return { providerName: match[1], modelName: match[2] };
    }
    return { providerName: null, modelName: model.replace(/^"|"$/g, '') };
  }, []);

  // Auto-select the default provider's model so a brand-new session can chat
  // immediately without the user picking a model first.
  useEffect(() => {
    let cancelled = false;
    const resolveDefaultModel = async () => {
      if (sessionModel) return;
      try {
        const provider = await getActiveProviderIPC();
        if (cancelled || !provider) return;
        const isUsable = provider.hasApiKey || provider.providerType === 'ollama';
        if (!isUsable) return;
        let modelId = '';
        try {
          const opts = JSON.parse(provider.options || '{}');
          if (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
            modelId = opts.enabled_models[0];
          } else if (typeof opts.defaultModel === 'string' && opts.defaultModel) {
            modelId = opts.defaultModel;
          }
        } catch {
          // Ignore malformed options; fall through to provider.defaultModel.
        }
        if (!modelId && provider.defaultModel) modelId = provider.defaultModel;
        if (!modelId) return;
        const cleanId = modelId.startsWith('"') && modelId.endsWith('"') ? modelId.slice(1, -1) : modelId;
        const providerName = provider.name || provider.providerType || provider.id;
        setSessionModel(`[${providerName}] ${cleanId}`);
        setProviderId(provider.id);
      } catch {
        // Ignore provider resolution errors.
      }
    };
    void resolveDefaultModel();
    const retryTimer = setTimeout(() => void resolveDefaultModel(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [sessionModel]);

  const handleModelChange = useCallback((model: string, nextProviderId?: string) => {
    setSessionModel(model);
    if (nextProviderId) {
      setProviderId(nextProviderId);
    }
  }, []);

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
  }, []);

  const handleDraftChange = useCallback(
    (text: string, attachments: FileAttachment[]) => {
      updateNewChatDraft({
        text,
        attachments,
        hasContent: text.trim().length > 0 || attachments.length > 0,
      });
    },
    [updateNewChatDraft],
  );

  // Synchronous fallback: resolve the default provider model when the async
  // effect hasn't finished yet, so the first send never passes an empty model.
  const resolveDefaultModelSync = useCallback(async (): Promise<{ modelName: string; providerId: string } | null> => {
    try {
      const provider = await getActiveProviderIPC();
      if (!provider) return null;
      const isUsable = provider.hasApiKey || provider.providerType === 'ollama';
      if (!isUsable) return null;
      let modelId = '';
      try {
        const opts = JSON.parse(provider.options || '{}');
        if (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
          modelId = opts.enabled_models[0];
        } else if (typeof opts.defaultModel === 'string' && opts.defaultModel) {
          modelId = opts.defaultModel;
        }
      } catch {
        // ignore
      }
      if (!modelId && provider.defaultModel) modelId = provider.defaultModel;
      if (!modelId) return null;
      const cleanId = modelId.startsWith('"') && modelId.endsWith('"') ? modelId.slice(1, -1) : modelId;
      const providerName = provider.name || provider.providerType || provider.id;
      return { modelName: `[${providerName}] ${cleanId}`, providerId: provider.id };
    } catch {
      return null;
    }
  }, []);

  const handleSend = useCallback(
    async (
      content: string,
      files?: FileAttachment[],
      outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
    ) => {
      if (!content.trim() && (files?.length ?? 0) === 0) return;
      if (isSending) return;
      setIsSending(true);
      try {
        // Read from refs to always get the latest model/provider.
        let effectiveModel = sessionModelRef.current;
        let effectiveProviderId = providerIdRef.current;
        if (!effectiveModel) {
          const resolved = await resolveDefaultModelSync();
          if (resolved) {
            effectiveModel = resolved.modelName;
            effectiveProviderId = resolved.providerId;
            setSessionModel(effectiveModel);
            setProviderId(effectiveProviderId);
          }
        }
        const { modelName: actualModel } = parseModelName(effectiveModel || '');

        // Resolve a working directory so the new session is grouped under a
        // project when possible. Fall back to the most recent folder, then the
        // default workspace, then a no-project session.
        let workingDirectory: string | undefined;
        let projectName: string | undefined;
        try {
          const folders = await ((window.electronAPI?.projects?.getRecentFolders?.()) ?? Promise.resolve([]));
          if (Array.isArray(folders) && folders.length > 0) {
            workingDirectory = folders[0];
          }
        } catch {
          // ignore
        }
        if (!workingDirectory) {
          try {
            const ws = await window.electronAPI?.app?.getDefaultWorkspace?.();
            if (ws) workingDirectory = ws;
          } catch {
            // ignore
          }
        }
        if (workingDirectory) {
          projectName = workingDirectory.split(/[\\/]/).pop() || undefined;
        }

        const thread = await createThread({
          workingDirectory,
          projectName,
          noProject: !workingDirectory,
          providerId: effectiveProviderId || undefined,
          model: actualModel || undefined,
        });
        if (!thread) return;

        // Draft consumed — clear it now that a real thread exists.
        clearNewChatDraft();
        setActiveThread(thread.id);

        // Wait for React to render ChatView, then send via ref to avoid a
        // stale closure (mirrors WelcomeView's double-rAF handoff).
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const send = onSendMessageRef.current;
            send?.(content, permissionMode, actualModel, files, undefined, outputStyleConfig);
          });
        });
      } catch (error) {
        console.error('[NewChatView] Failed to create thread:', error);
      } finally {
        setIsSending(false);
      }
    },
    [createThread, setActiveThread, clearNewChatDraft, parseModelName, resolveDefaultModelSync, isSending, permissionMode],
  );

  return (
    <div className="new-chat-view">
      <div className="new-chat-content">
        <div className="w-full max-w-[800px] flex flex-col items-center">
          <MessageInput
            onSend={handleSend}
            disabled={isSending}
            isStreaming={false}
            modelName={sessionModel}
            onModelChange={handleModelChange}
            permissionMode={permissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            placeholder={t('chat.describeWhatToBuild')}
            popoverPlacement="bottom"
            draftMode
            initialDraft={{ text: newChatDraft.text, attachments: newChatDraft.attachments }}
            onDraftChange={handleDraftChange}
          />
        </div>
      </div>
    </div>
  );
}