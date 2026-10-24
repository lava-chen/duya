import type { ComponentType } from "react";
import {
  ChartBarIcon,
  ChartLineIcon,
  DatabaseIcon,
  FileTextIcon,
  GlobeIcon,
  PlugIcon,
  SquaresFourIcon,
  type IconProps,
} from "@/components/icons";

const ALLOWED_SURFACE_ICONS: Readonly<Record<string, ComponentType<IconProps>>> = {
  "chart-bar": ChartBarIcon,
  "chart-line": ChartLineIcon,
  database: DatabaseIcon,
  "file-text": FileTextIcon,
  globe: GlobeIcon,
  grid: SquaresFourIcon,
  plug: PlugIcon,
};

/** Resolve manifest icon IDs only through the host-owned allowlist. */
export function getPluginUiSurfaceIcon(iconId: unknown): ComponentType<IconProps> {
  return typeof iconId === "string" ? ALLOWED_SURFACE_ICONS[iconId] ?? PlugIcon : PlugIcon;
}
