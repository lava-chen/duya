"use client";

import { Image as ImageIcon } from "@phosphor-icons/react";
import type { WidgetComponentProps, WidgetDefinition } from "./registry";

interface ImageCardData {
  src: string;
  alt: string;
  caption: string;
  fit: "cover" | "contain" | "fill";
  rounded: boolean;
}

const FIT_STYLE: Record<string, React.CSSProperties> = {
  cover: { objectFit: "cover" },
  contain: { objectFit: "contain" },
  fill: { objectFit: "fill" },
};

function ImageCardWidget({ data, config }: WidgetComponentProps) {
  const img = (data as unknown as ImageCardData) || {
    src: "",
    alt: "Image",
    caption: "",
    fit: "cover",
    rounded: true,
  };

  if (!img.src) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--muted)]">
        <ImageIcon size={32} weight="duotone" />
        <span className="text-xs">Paste an image URL</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex-1 min-h-0 overflow-hidden">
        <img
          src={img.src}
          alt={img.alt || "Image"}
          style={{
            ...FIT_STYLE[img.fit || "cover"],
            width: "100%",
            height: "100%",
            borderRadius: img.rounded ? "8px" : "0",
          }}
        />
      </div>
      {img.caption && (
        <span className="text-[11px] text-[var(--muted)] text-center truncate">
          {img.caption}
        </span>
      )}
    </div>
  );
}

export const ImageCardDefinition: WidgetDefinition = {
  kind: "builtin",
  type: "image-card",
  label: "Image Card",
  description: "Display an image with optional caption",
  component: ImageCardWidget,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
  defaultData: {
    src: "",
    alt: "Image",
    caption: "",
    fit: "cover",
    rounded: true,
  },
  defaultConfig: {
    title: "🖼️ Image",
  },
};