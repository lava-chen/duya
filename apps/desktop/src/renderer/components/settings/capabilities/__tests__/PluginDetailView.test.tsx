// @vitest-environment jsdom

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type {
  PluginCatalogEntry,
  PluginRegistryEntry,
} from "@/lib/plugin-types";
import type {
  AppConnectionProviderDTO,
  AppConnectionStatusDTO,
} from "@/lib/app-connection-ipc";

// Mock translation: keys render verbatim so assertions target i18n keys.
vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({ t: (k: string) => k, locale: "en" }),
}));

const manifest = {
  schemaVersion: "duya.plugin.v2",
  id: "linear",
  name: "Linear",
  version: "5.0.1",
  description: "Plan and build products",
  author: { name: "Linear Orbit, Inc" },
  components: { mcpServers: [], appConnections: ["notion"], skills: [], workflows: [] },
  permissions: [{ name: "workspace.read" }],
  engines: { duya: "*" },
  interface: { brandColor: "#5E6AD2", shortDescription: "Plan and build products" },
};

const catalogEntry = {
  id: "linear",
  name: "Linear",
  version: "5.0.1",
  description: "Plan and build products",
  shortDescription: "Plan and build products",
  longDescription: "Manage issues, projects, and team workflows from chat.",
  author: { name: "Linear Orbit, Inc", url: "https://linear.app" },
  source: "bundled",
  category: "productivity",
  capabilityCounts: { skills: 1, mcpServers: 1, cli: 0, ui: 0, hooks: 0, workflows: 0 },
  usageExamples: [{ prompt: "Triage or update relevant issues for this task" }],
  capabilities: [
    {
      id: "mcp-linear",
      name: "linear-server",
      type: "mcp",
      description: "linear mcp server",
      required: true,
      enabled: true,
    },
    {
      id: "skill-triage",
      name: "triage",
      type: "skill",
      description: "Triage issues",
      required: true,
      enabled: true,
    },
  ],
  manifest,
} as unknown as PluginCatalogEntry;

const installedEntry = {
  id: "linear",
  name: "Linear",
  version: "5.0.1",
  description: "Plan and build products",
  author: { name: "Linear Orbit, Inc" },
  enabled: true,
  installPath: "/plugins/linear",
  installedAt: new Date().toISOString(),
  source: "bundled",
  trustLevel: "official",
  runtimeStatus: "enabled",
  permissionsGranted: ["workspace.read"],
  permissionDenied: [],
  setupRequired: false,
  setupFields: [],
  manifest,
} as unknown as PluginRegistryEntry;

const notionProvider = {
  id: "notion",
  label: "Notion",
  configured: true,
  supportsManualConfiguration: false,
  requiresClientSecret: false,
  monogram: "N",
  description: "Search and edit your Notion workspace",
} as unknown as AppConnectionProviderDTO;

const notionConnection = {
  id: "conn-1",
  provider: "notion",
  accountLabel: "me@example.com",
  accountId: "user-1",
  scopes: [],
  status: "connected",
  expiresAt: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
  connectionSlug: "",
} as unknown as AppConnectionStatusDTO;

function renderDetail(overrides?: {
  onBack?: () => void;
  onRemove?: () => void;
  onLaunchWorkflow?: (prompt: string) => void;
  onSkillClick?: (skill: { name: string }) => void;
  onConnectProvider?: (provider: AppConnectionProviderDTO) => void;
  onDisconnectConnection?: (connectionId: string) => void;
  onRemoveConnection?: (connectionId: string) => void;
  providers?: AppConnectionProviderDTO[];
  connections?: AppConnectionStatusDTO[];
}) {
  const props = {
    installed: installedEntry,
    catalog: catalogEntry,
    onBack: overrides?.onBack ?? vi.fn(),
    busy: false,
    onRemove: overrides?.onRemove,
    onLaunchWorkflow: overrides?.onLaunchWorkflow,
    onSkillClick: overrides?.onSkillClick,
    providers: overrides?.providers,
    connections: overrides?.connections,
    onConnectProvider: overrides?.onConnectProvider,
    onDisconnectConnection: overrides?.onDisconnectConnection,
    onRemoveConnection: overrides?.onRemoveConnection,
  };
  return render(<PluginDetailView {...props} />);
}

// Import after mocks so the mocked hook applies.
import { PluginDetailView } from "../PluginDetailView";

describe("PluginDetailView", () => {
  it("renders breadcrumb, title, tagline, hero prompt, includes rows and info section", () => {
    renderDetail();

    // Breadcrumb root (t returns the key verbatim).
    expect(screen.getByText("extensions.tabs.plugins")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Linear" })
    ).toBeInTheDocument();
    expect(screen.getByText("Plan and build products")).toBeInTheDocument();

    // Primary action for an enabled installed plugin is "Try it out".
    expect(
      screen.getByText("settings.capabilities.detailTryNow")
    ).toBeInTheDocument();

    // Hero banner carries the first usage example.
    expect(
      screen.getByText(/Triage or update relevant issues/)
    ).toBeInTheDocument();

    // Includes rows: MCP connector + skill.
    expect(screen.getByText("linear-server")).toBeInTheDocument();
    expect(screen.getByText("triage")).toBeInTheDocument();
    expect(screen.getByText("settings.capabilities.detailIncludes")).toBeInTheDocument();

    // Information section with developer + version.
    expect(screen.getByText("settings.capabilities.detailInfo")).toBeInTheDocument();
    expect(screen.getByText("settings.capabilities.detailDeveloper")).toBeInTheDocument();
    expect(screen.getByText("Linear Orbit, Inc")).toBeInTheDocument();
    expect(screen.getByText("v5.0.1")).toBeInTheDocument();
  });

  it("clicking the hero banner dispatches the prefill event and hands off to the parent", () => {
    const onLaunchWorkflow = vi.fn();
    renderDetail({ onLaunchWorkflow });

    let received: string | null = null;
    const handler = (e: Event) => {
      received = (e as CustomEvent<{ value: string }>).detail.value;
    };
    window.addEventListener("duya:prefill-chat-input", handler);

    // All example cards live inside the hero banner; click the first one.
    fireEvent.click(screen.getAllByTitle("settings.capabilities.detailSendPrompt")[0]);

    window.removeEventListener("duya:prefill-chat-input", handler);

    expect(onLaunchWorkflow).toHaveBeenCalledWith(
      "Triage or update relevant issues for this task"
    );
    expect(received).toBe("Triage or update relevant issues for this task");
  });

  it("breadcrumb navigates back and skill rows invoke onSkillClick", () => {
    const onBack = vi.fn();
    const onSkillClick = vi.fn();
    renderDetail({ onBack, onSkillClick });

    fireEvent.click(screen.getByText("extensions.tabs.plugins"));
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("triage"));
    expect(onSkillClick).toHaveBeenCalledWith(
      expect.objectContaining({ name: "triage" })
    );
  });

  it("the more-options menu exposes disable and uninstall for an enabled plugin", () => {
    const onRemove = vi.fn();
    renderDetail({ onRemove });

    fireEvent.click(screen.getByLabelText("extensions.actions.more"));
    expect(
      screen.getByText("settings.capabilities.actionDisable")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("settings.capabilities.actionRemove"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hides the connected-accounts section when no connection props are given", () => {
    renderDetail();

    expect(
      screen.queryByText("settings.capabilities.detailConnectedAccounts")
    ).not.toBeInTheDocument();
  });

  it("renders connected accounts for declared app connectors and wires the connect flow", () => {
    const onConnectProvider = vi.fn();
    const onDisconnectConnection = vi.fn();
    const onRemoveConnection = vi.fn();
    renderDetail({
      onConnectProvider,
      onDisconnectConnection,
      onRemoveConnection,
      providers: [notionProvider],
      connections: [notionConnection],
    });

    expect(
      screen.getByText("settings.capabilities.detailConnectedAccounts")
    ).toBeInTheDocument();
    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(
      screen.getByText("settings.capabilities.detailConnectAnother")
    ).toBeInTheDocument();

    // Connect-another hands the resolved provider DTO to the parent.
    fireEvent.click(
      screen.getByText("settings.capabilities.detailConnectAnother")
    );
    expect(onConnectProvider).toHaveBeenCalledWith(notionProvider);

    // Row menu: disconnect and remove route to the parent handlers.
    fireEvent.click(
      screen.getByLabelText("settings.capabilities.detailAccountOptions")
    );
    fireEvent.click(screen.getByText("extensions.actions.disconnect"));
    expect(onDisconnectConnection).toHaveBeenCalledWith("conn-1");

    fireEvent.click(
      screen.getByLabelText("settings.capabilities.detailAccountOptions")
    );
    fireEvent.click(screen.getByText("extensions.actions.remove"));
    expect(onRemoveConnection).toHaveBeenCalledWith("conn-1");
  });
});
