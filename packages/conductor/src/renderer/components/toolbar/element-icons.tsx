import type { ReactNode } from "react";
import {
  ArrowElbowDownRightIcon,
  CursorIcon,
  ImageSquareIcon,
  FileTextIcon,
  HandIcon,
  LinkSimpleIcon,
  NoteIcon,
  SquareIcon,
  TextTIcon,
  TableIcon,
  DatabaseIcon,
} from "@/components/icons";

const iconProps = { size: 20, "aria-hidden": true };

/** One coherent, pixel-aligned icon family for the compact canvas toolbar. */
export const ELEMENT_ICONS: Record<
  "sticky" | "document" | "connector" | "media" | "select" | "hand" | "shape" | "link" | "text" | "table" | "database",
  ReactNode
> = {
  select: <CursorIcon {...iconProps} />,
  hand: <HandIcon {...iconProps} />,
  shape: <SquareIcon {...iconProps} />,
  sticky: <NoteIcon {...iconProps} />,
  document: <FileTextIcon {...iconProps} />,
  text: <TextTIcon {...iconProps} />,
  table: <TableIcon {...iconProps} />,
  database: <DatabaseIcon {...iconProps} />,
  connector: <ArrowElbowDownRightIcon {...iconProps} />,
  media: <ImageSquareIcon {...iconProps} />,
  link: <LinkSimpleIcon {...iconProps} />,
};
