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
} from "@/components/settings";
import { UsageDashboard } from "@/components/usage";

export function SettingsView() {
  const { settingsTab } = useConversationStore();

  return (
    <div className="settings-page-content">
      <div className="settings-content">
        {settingsTab === "general" && <GeneralSection />}
        {settingsTab === "appearance" && <AppearanceSection />}
        {settingsTab === "providers" && <ProvidersSection />}
        {settingsTab === "skills" && <SkillsSection />}
        {settingsTab === "mcp" && <MCPSection />}
        {settingsTab === "channels" && <BridgeSection />}
        {settingsTab === "browser" && <BrowserExtensionSection />}
        {settingsTab === "security" && <SecuritySection />}
        {settingsTab === "usage" && <UsageDashboard />}
        {settingsTab === "agents" && <AgentsSection />}
        {settingsTab === "support" && <SupportSection />}
      </div>
    </div>
  );
}
