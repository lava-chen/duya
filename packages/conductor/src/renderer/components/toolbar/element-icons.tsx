import type { ReactNode } from "react";
import {
  ArrowElbowDownRight,
  Cursor,
  ImageSquare,
  FileText,
  Hand,
  LinkSimple,
  Note,
  Square,
  TextT,
  Table,
  Database,
} from "@phosphor-icons/react";

const iconProps = { size: 20, weight: "regular" as const, "aria-hidden": true };

/** One coherent, pixel-aligned icon family for the compact canvas toolbar. */
export const ELEMENT_ICONS: Record<
  "sticky" | "document" | "connector" | "media" | "select" | "hand" | "shape" | "link" | "text" | "table" | "database",
  ReactNode
> = {
  select: <Cursor {...iconProps} />,
  hand: <Hand {...iconProps} />,
  shape: <Square {...iconProps} />,
  sticky: <Note {...iconProps} />,
  document: <FileText {...iconProps} />,
  text: <TextT {...iconProps} />,
  table: <Table {...iconProps} />,
  database: <Database {...iconProps} />,
  connector: <ArrowElbowDownRight {...iconProps} />,
  media: <ImageSquare {...iconProps} />,
  link: <LinkSimple {...iconProps} />,
};
