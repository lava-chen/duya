"use client";

import { useConversationStore } from "@/stores/conversation-store";
import {
  GeneralSection,
  AppearanceSection,
  ProvidersSection,
  SkillsSection,
  BridgeSection,
  BrowserExtensionSection,
  SecuritySection,
  MCPSection,
  AgentsSection,
  SupportSection,
  CapabilitiesSection,
} from "@/components/settings";
import { UsageDashboard } from "@/components/usage";
import { ProviderPickerView } from "@/components/providers/ProviderPickerView";
import { ProviderEditView } from "@/components/providers/ProviderEditView";

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
        {settingsTab === "skills" && <SkillsSection />}
        {settingsTab === "mcp" && <MCPSection />}
        {settingsTab === "channels" && <BridgeSection />}
        {settingsTab === "browser" && <BrowserExtensionSection />}
        {settingsTab === "security" && <SecuritySection />}
        {settingsTab === "usage" && <UsageDashboard />}
        {settingsTab === "agents" && <AgentsSection />}
        {settingsTab === "support" && <SupportSection />}
        {settingsTab === "plugins" && <CapabilitiesSection />}
      </div>
    </div>
  );
}
