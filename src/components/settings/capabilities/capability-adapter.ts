import type { PluginCatalogEntry, PluginManifest, PluginRegistryEntry } from "@/lib/plugin-types";

export type IncludeItemKind =
  | "app"
  | "mcp"
  | "cli"
  | "skill"
  | "hook"
  | "ui";

export interface IncludeItem {
  id: string;
  name: string;
  kind: IncludeItemKind;
  kindLabel: string;
  description: string;
  enabled: boolean;
  configurable: boolean;
  needsSetup?: boolean;
}

export interface UsageExample {
  title?: string;
  prompt: string;
}

const KIND_LABELS: Record<IncludeItemKind, string> = {
  app: "App",
  mcp: "MCP",
  cli: "CLI",
  skill: "Skill",
  hook: "Hook",
  ui: "UI",
};

export function buildIncludes(
  entry: PluginCatalogEntry | PluginRegistryEntry | null,
): IncludeItem[] {
  if (!entry) return [];

  const manifest: PluginManifest | undefined =
    "manifest" in entry ? (entry as PluginRegistryEntry).manifest : undefined;

  const items: IncludeItem[] = [];

  if (manifest?.capabilities?.mcpServers) {
    for (const s of manifest.capabilities.mcpServers) {
      items.push({
        id: `mcp-${s.name}`,
        name: s.name,
        kind: "mcp",
        kindLabel: KIND_LABELS.mcp,
        description: s.command,
        enabled: true,
        configurable: false,
      });
    }
  }

  if (manifest?.capabilities?.cli) {
    for (const c of manifest.capabilities.cli) {
      items.push({
        id: `cli-${c.name}`,
        name: c.name,
        kind: "cli",
        kindLabel: KIND_LABELS.cli,
        description: c.command,
        enabled: true,
        configurable: false,
      });
    }
  }

  if (manifest?.capabilities?.skills) {
    for (const s of manifest.capabilities.skills) {
      const skillPath = typeof s === "string" ? s : (s as { path: string }).path ?? "";
      const skillDesc = typeof s === "string" ? undefined : (s as { description?: string }).description;
      items.push({
        id: `skill-${skillPath}`,
        name: skillPath.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, ""),
        kind: "skill",
        kindLabel: KIND_LABELS.skill,
        description: skillDesc ?? `Skill: ${skillPath}`,
        enabled: true,
        configurable: false,
      });
    }
  }

  if (manifest?.capabilities?.hooks) {
    const HOOK_FRIENDLY_NAMES: Record<string, string> = {
      "research.session": "Research Session",
    };
    for (const h of manifest.capabilities.hooks) {
      items.push({
        id: `hook-${h.event}`,
        name: HOOK_FRIENDLY_NAMES[h.event] ?? h.event,
        kind: "hook",
        kindLabel: KIND_LABELS.hook,
        description: `Registers plugin tools during ${h.event.replace(/\./g, " ")}`,
        enabled: true,
        configurable: false,
      });
    }
  }

  if (manifest?.capabilities?.ui) {
    for (const u of manifest.capabilities.ui) {
      items.push({
        id: `ui-${u.id}`,
        name: u.id,
        kind: "ui",
        kindLabel: KIND_LABELS.ui,
        description: `${u.type} panel: ${u.entry}`,
        enabled: true,
        configurable: false,
      });
    }
  }

  if (items.length === 0 && "capabilityCounts" in entry && entry.capabilityCounts) {
    const counts = entry.capabilityCounts;
    if (counts.mcpServers) {
      items.push({
        id: "mcp-servers",
        name: "MCP Servers",
        kind: "mcp",
        kindLabel: KIND_LABELS.mcp,
        description: `${counts.mcpServers} MCP server(s)`,
        enabled: true,
        configurable: false,
      });
    }
    if (counts.cli) {
      items.push({
        id: "cli-tools",
        name: "CLI Tools",
        kind: "cli",
        kindLabel: KIND_LABELS.cli,
        description: `${counts.cli} CLI tool(s)`,
        enabled: true,
        configurable: false,
      });
    }
    if (counts.skills) {
      items.push({
        id: "skills",
        name: "Skills",
        kind: "skill",
        kindLabel: KIND_LABELS.skill,
        description: `${counts.skills} skill(s)`,
        enabled: true,
        configurable: false,
      });
    }
    if (counts.ui) {
      items.push({
        id: "ui-panels",
        name: "UI Panels",
        kind: "ui",
        kindLabel: KIND_LABELS.ui,
        description: `${counts.ui} panel(s)`,
        enabled: true,
        configurable: false,
      });
    }
  }

  return items;
}

export function getUsageExamples(
  _entry: PluginCatalogEntry | PluginRegistryEntry | null,
): UsageExample[] {
  const entry = _entry;
  if (!entry) return [];

  if ("usageExamples" in entry && Array.isArray(entry.usageExamples) && entry.usageExamples.length > 0) {
    return entry.usageExamples;
  }

  const name = entry.name || "plugin";
  const lowered = name.toLowerCase();

  if (lowered.includes("literature") || lowered.includes("paper") || lowered.includes("pdf")) {
    return [
      { prompt: `Import this PDF and create a reference record for my literature library.` },
      { prompt: `Search my local literature library for papers about precipitation nowcasting.` },
      { prompt: `Build an evidence table from these 5 papers.` },
    ];
  }

  return [
    {
      prompt: `What can ${name} help me with?`,
    },
    {
      prompt: `Enable ${name} and show me how to use its capabilities.`,
    },
  ];
}

export function getKindIconClass(kind: IncludeItemKind): string {
  switch (kind) {
    case "app":
      return "bg-accent/10 text-accent";
    case "mcp":
      return "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-500";
    case "cli":
      return "bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-500";
    case "skill":
      return "bg-violet-100 text-violet-700 dark:bg-violet-500/10 dark:text-violet-500";
    case "hook":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-500";
    case "ui":
      return "bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-500";
  }
}

export function getKindFirstLetter(kind: IncludeItemKind): string {
  switch (kind) {
    case "app":
      return "A";
    case "mcp":
      return "M";
    case "cli":
      return "C";
    case "skill":
      return "S";
    case "hook":
      return "H";
    case "ui":
      return "U";
  }
}
