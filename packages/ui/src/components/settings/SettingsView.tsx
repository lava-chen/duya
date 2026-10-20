"use client";

import { useConversationStore } from "@/stores/conversation-store";
import {
  GeneralSection,
  AppearanceSection,
  ProvidersSection,
  BridgeSection,
  BrowserExtensionSection,
  SecuritySection,
  AgentsSection,
  SupportSection,
  MemorySection,
  HooksSection,
  VoiceSection,
  PerformanceSection,
  WakeAgentSection,
} from "@/components/settings";
import { UsageDashboard } from "@/components/usage";
import { ProviderPickerView } from "@/components/providers/ProviderPickerView";
import { ProviderEditView } from "@/components/providers/ProviderEditView";

export function SettingsView() {
  const { settingsTab } = useConversationStore();

  // `extensions` is persisted UI state but was promoted to a top-level view
  // (rendered by App.tsx, not here). A session restored with the old value
  // would fall through every branch below and show an empty pane.
  const tab = settingsTab === "extensions" ? "general" : settingsTab;

  return (
    <div className="settings-page-content">
      <div className="settings-content">
        {tab === "general" && <GeneralSection />}
        {tab === "appearance" && <AppearanceSection />}
        {tab === "providers" && <ProvidersSection />}
        {/* Plan 205: inline sub-views for adding / editing a provider. */}
        {tab === "provider-picker" && <ProviderPickerView />}
        {tab === "provider-edit" && <ProviderEditView />}
        {tab === "channels" && <BridgeSection />}
        {tab === "browser" && <BrowserExtensionSection />}
        {tab === "security" && <SecuritySection />}
        {tab === "usage" && <UsageDashboard />}
        {tab === "agents" && <AgentsSection />}
        {tab === "support" && <SupportSection />}
        {tab === "memory" && <MemorySection />}
        {tab === "hooks" && <HooksSection />}
        {tab === "voice" && <VoiceSection />}
        {tab === "performance" && <PerformanceSection />}
        {tab === "wake" && <WakeAgentSection />}
      </div>
    </div>
  );
}
