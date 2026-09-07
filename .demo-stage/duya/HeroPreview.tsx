"use client";

/**
 * HeroPreview — DUYA UI preview for the hero section.
 *
 * Thin frame wrapper around the static demo player `DuyaPreview` (the
 * real app shell replica). The player renders EXACTLY the same CSS class
 * names as the real DUYA desktop app, so the shipped preview styles
 * (duya-preview.css + duya-preview-bot.css) style it pixel-identically.
 */

import DuyaPreview from "./duya/DuyaPreview";

export default function HeroPreview() {
  return (
    <div
      className="hero-preview-frame"
      style={{
        position: "relative",
        width: "100%",
        height: "660px",
        borderRadius: "14px",
        overflow: "hidden",
        background: "var(--main-bg)",
        border: "1px solid var(--border)",
      }}
    >
      <DuyaPreview />
    </div>
  );
}