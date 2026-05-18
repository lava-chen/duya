"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { ChatView } from "@/components/chat/ChatView";
import { WelcomeView } from "@/components/home/WelcomeView";
import { SkillsView } from "@/components/skills/SkillsView";
import { ChannelsView } from "@/components/bridge/ChannelsView";
import { AutomationView } from "@/components/automation/AutomationView";
import { ConductorView } from "@/components/conductor/ConductorView";
import { SettingsView } from "@/components/settings/SettingsView";
import { AppShell } from "@/components/layout/app-shell";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { FontProvider } from "@/contexts/FontContext";
import { ensureSession, startStream, stopStream, subscribeSession, getSnapshot, setToolTimeoutCallback, subscribeToDbPersisted, canSend } from "@/lib/stream-session-manager";
import { useSettings } from "@/hooks/useSettings";
import type { Message, SessionStreamSnapshot, StreamPhase, FileAttachment } from "@/types/message";
import type { PermissionMode } from "@/components/chat/PermissionModeSelector";
import { stripPastedContentMarkers } from "@/lib/message-content-parser";
import { interruptChat } from "@/lib/agent-sse-client";

const ACTIVE_LIKE_PHASES: StreamPhase[] = ['starting', 'streaming', 'awaiting_permission', 'persisting'];
const isActiveLike = (phase: StreamPhase) => ACTIVE_LIKE_PHASES.includes(phase);

function buildOptimisticMessages(snapshot: SessionStreamSnapshot): Message[] {
  const messages: Message[] = [];
  const now = Date.now();

  if (snapshot.streamingThinkingContent) {
    messages.push({
      id: `optimistic-thinking-${snapshot.streamId || now}`,
      role: 'assistant',
      content: snapshot.streamingThinkingContent,
      timestamp: now - 2,
      msgType: 'thinking',
      thinking: snapshot.streamingThinkingContent,
    });
  }

  for (const toolUse of snapshot.toolUses) {
    messages.push({
      id: `optimistic-tool-${toolUse.id}`,
      role: 'assistant',
      content: toolUse.input ? JSON.stringify(toolUse.input) : '',
      timestamp: now - 1,
      msgType: 'tool_use',
      toolName: toolUse.name,
      toolInput: toolUse.input ? JSON.stringify(toolUse.input) : null,
      tool_call_id: toolUse.id,
      name: toolUse.name,
    });
  }

  for (const result of snapshot.toolResults) {
    messages.push({
      id: `optimistic-result-${result.tool_use_id}`,
      role: 'tool',
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      timestamp: now - 1,
      msgType: 'tool_result',
      parentToolCallId: result.tool_use_id,
      tool_call_id: result.tool_use_id,
      status: result.is_error ? 'error' : 'done',
    });
  }

  const textContent = snapshot.finalMessageContent || snapshot.streamingContent;
  if (textContent) {
    messages.push({
      id: `optimistic-text-${snapshot.streamId || now}`,
      role: 'assistant',
      content: textContent,
      timestamp: now,
    });
  }

  return messages;
}

export function App() {
  const {
    currentView,
    activeThreadId,
    messages,
    setActiveThread,
    addMessage,
    loadThreadMessages,
  } = useConversationStore();
  const { settings } = useSettings();

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingSnapshot, setStreamingSnapshot] = useState<SessionStreamSnapshot | null>(null);
  const prevPhaseRef = useRef<StreamPhase>('idle');

  // Subscribe to stream snapshot updates with optimistic message injection
  useEffect(() => {
    if (!activeThreadId) return;

    ensureSession(activeThreadId);
    const initialSnapshot = getSnapshot(activeThreadId);
    if (initialSnapshot) {
      setIsStreaming(isActiveLike(initialSnapshot.phase));
      setStreamingSnapshot(initialSnapshot);
      prevPhaseRef.current = initialSnapshot.phase;
    }

    const unsubscribe = subscribeSession(activeThreadId, (snapshot) => {
      const wasActive = isActiveLike(prevPhaseRef.current);
      const isActive = isActiveLike(snapshot.phase);

      // Phase transition: active → non-active (stream ended)
      // Inject optimistic messages to avoid blank gap before DB load completes.
      // Do NOT call loadThreadMessages here — db_persisted event is the authoritative
      // signal that messages have been persisted and will trigger the DB reload.
      if (wasActive && !isActive) {
        const optimistic = buildOptimisticMessages(snapshot);
        if (optimistic.length > 0) {
          const store = useConversationStore.getState();
          const current = store.messages[activeThreadId] ?? [];
          useConversationStore.setState({
            messages: {
              ...store.messages,
              [activeThreadId]: [...current, ...optimistic],
            },
          });
        }
        // DB reload is triggered by db_persisted event below — do not call loadThreadMessages here
      }

      prevPhaseRef.current = snapshot.phase;
      setIsStreaming(isActive);
      setStreamingSnapshot(snapshot);
    });

    return unsubscribe;
  }, [activeThreadId, loadThreadMessages]);

  // Subscribe to db_persisted events: reload messages from DB
  useEffect(() => {
    if (!activeThreadId) return;

    ensureSession(activeThreadId);
    const unsubscribe = subscribeToDbPersisted(activeThreadId, (event) => {
      const startTime = performance.now();
      console.log(`[App] db_persisted received: ${activeThreadId.slice(0, 8)}, success=${event.success}, elapsedSinceEvent=${event.timestamp ? (Date.now() - event.timestamp) : 'unknown'}ms`);
      if (event.success) {
        console.log(`[App] calling loadThreadMessages: ${activeThreadId.slice(0, 8)}`);
        loadThreadMessages(activeThreadId);
      }
    });

    return unsubscribe;
  }, [activeThreadId, loadThreadMessages]);

  // Handle notification click to navigate to session
  useEffect(() => {
    if (window.electronAPI?.onNotificationClicked) {
      const unsubscribe = window.electronAPI.onNotificationClicked((data) => {
        if (data.sessionId) {
          setActiveThread(data.sessionId);
        }
      });
      return unsubscribe;
    }
  }, [setActiveThread]);

  const handleSendMessage = useCallback(
    (content: string, uiPermissionMode: PermissionMode = 'ask', model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null) => {
    if (!activeThreadId || !canSend(activeThreadId)) return;

    const now = Date.now();

    // Store message — attachments now carry full parsed data (images + documents)
    const userMsgId = crypto.randomUUID();
    const userMsg: Message = {
      id: userMsgId,
      role: "user",
      content,
      timestamp: now,
      attachments: files,
    };
    console.log('[App] handleSendMessage:', {
      contentLength: content.length,
      filesCount: files?.length,
      filesWithText: files?.filter(f => f.text)?.map(f => ({ name: f.name, textLength: f.text?.length })),
      filesWithImageChunks: files?.filter(f => f.imageChunks)?.map(f => ({ name: f.name, chunks: f.imageChunks?.length })),
    });

    addMessage(activeThreadId, userMsg);

    setIsStreaming(true);

    // Strip markers before sending to API
    const plainContent = stripPastedContentMarkers(content);

    // Map UI permission mode to agent internal mode
    const agentPermissionMode = uiPermissionMode === 'bypass' ? 'bypassPermissions' : 'default';

    void startStream({
      sessionId: activeThreadId,
      content: plainContent,
      permissionMode: agentPermissionMode,
      model,
      files,
      agentProfileId,
      outputStyleConfig: outputStyleConfig ?? undefined,
      titleGenerationModel: settings.titleGenerationModel,
    });

    setToolTimeoutCallback(activeThreadId, (retryContent: string) => {
      if (!activeThreadId || !canSend(activeThreadId)) return;

      const retryMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: retryContent,
        timestamp: Date.now(),
      };

      addMessage(activeThreadId, retryMsg);
      // Strip markers before sending to API
      const plainRetryContent = stripPastedContentMarkers(retryContent);
      void startStream({ sessionId: activeThreadId, content: plainRetryContent, permissionMode: agentPermissionMode, model, agentProfileId, titleGenerationModel: settings.titleGenerationModel });
    });
  }, [activeThreadId, addMessage, settings.titleGenerationModel]);

  const handleInterrupt = useCallback(() => {
    if (activeThreadId) {
      stopStream(activeThreadId);
      // Send interrupt to Agent Server to kill the agent subprocess
      void interruptChat(activeThreadId);
    }
  }, [activeThreadId]);

  const threadMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const chatEverMountedRef = useRef(false);
  if (activeThreadId) {
    chatEverMountedRef.current = true;
  }
  const shouldRenderChat = chatEverMountedRef.current && !!activeThreadId;

  const renderView = () => {
    if (shouldRenderChat) {
      return (
        <>
          {currentView === 'home' && (
            <WelcomeView onSelectThread={setActiveThread} onSendMessage={handleSendMessage} />
          )}
          {currentView === 'chat' && (
            <ChatView
              key={activeThreadId}
              sessionId={activeThreadId}
              messages={threadMessages}
              onSendMessage={handleSendMessage}
              onInterrupt={handleInterrupt}
              isStreaming={isStreaming}
            />
          )}
          {currentView === 'skills' && <SkillsView />}
          {currentView === 'bridge' && <ChannelsView />}
          {currentView === 'automation' && <AutomationView />}
          {currentView === 'conductor' && <ConductorView />}
          {currentView === 'settings' && <SettingsView />}
        </>
      );
    }

    switch (currentView) {
      case 'chat':
      case 'home':
        return <WelcomeView onSelectThread={setActiveThread} onSendMessage={handleSendMessage} />;
      case 'skills':
        return <SkillsView />;
      case 'bridge':
        return <ChannelsView />;
      case 'automation':
        return <AutomationView />;
      case 'conductor':
        return <ConductorView />;
      case 'settings':
        return <SettingsView />;
      default:
        return <WelcomeView onSelectThread={setActiveThread} onSendMessage={handleSendMessage} />;
    }
  };

  return (
    <I18nProvider>
      <FontProvider>
        <AppShell>{renderView()}</AppShell>
      </FontProvider>
    </I18nProvider>
  );
}
