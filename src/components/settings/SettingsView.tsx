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
} from "@/components/settings";
import { UsageDashboard } from "@/components/usage";
import { ProviderPickerView } from "@/components/providers/ProviderPickerView";
import { ProviderEditView } from "@/components/providers/ProviderEditView";
import { ExtensionsPage } from "@/components/extensions/ExtensionsPage";

export function SettingsView() {
  const { settingsTab } = useConversationStore();

  return (
    <div className="settings-page-content">
      <div className="settings-content">
        {settingsTab === "general" && <GeneralSection />}
        {settingsTab === "appearance" && <AppearanceSection />}
        {settingsTab === "providers" && <ProvidersSection />}
        {/* Plan 205: inline sub-views for adding / editing a provider. */}
        {settingsTab === "provider-picker" && <ProviderPickerView />}
        {settingsTab === "provider-edit" && <ProviderEditView />}
        {settingsTab === "extensions" && <ExtensionsPage />}
        {settingsTab === "channels" && <BridgeSection />}
        {settingsTab === "browser" && <BrowserExtensionSection />}
        {settingsTab === "security" && <SecuritySection />}
        {settingsTab === "usage" && <UsageDashboard />}
        {settingsTab === "agents" && <AgentsSection />}
        {settingsTab === "support" && <SupportSection />}
        {settingsTab === "memory" && <MemorySection />}
      </div>
    </div>
  );
}
