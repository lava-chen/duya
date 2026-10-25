// Context usage card for the session rail (TaskDrawer).
//
// Mirrors the reference desktop app's "Context" card: a percent-used headline,
// a segmented bar, and a per-bucket legend. Data comes from the same
// context-usage store the composer ring reads — no second accounting path.
// The composer's own hover breakdown (plan D slice) stays the deep-dive
// surface; this card is the always-visible summary.

"use client";

import { useContextUsageStore } from "@/stores/context-usage-store";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

/** Fixed palette, one hue per composition bucket. Data colors, not theme
 *  colors — they must stay distinguishable in both light and dark themes. */
const BUCKET_COLORS: Record<string, string> = {
  conversation: "#1BAF7A",
  system: "#EDA100",
  toolDefinitions: "#EB6834",
  injectedContext: "#2A78D6",
  toolResults: "#9A6DE3",
  skills: "#56B4C8",
  attachments: "#D67AB9",
  memory: "#898781",
  providerOverhead: "#C3C2B7",
  unattributed: "#5C5A55",
};

const BUCKET_LABEL_KEYS: Record<string, TranslationKey> = {
  conversation: "panel.ctx.conversation",
  system: "panel.ctx.system",
  toolDefinitions: "panel.ctx.toolDefinitions",
  injectedContext: "panel.ctx.injectedContext",
  toolResults: "panel.ctx.toolResults",
  skills: "panel.ctx.skills",
  attachments: "panel.ctx.attachments",
  memory: "panel.ctx.memory",
  providerOverhead: "panel.ctx.providerOverhead",
  unattributed: "panel.ctx.unattributed",
};

const BUCKET_ORDER = Object.keys(BUCKET_LABEL_KEYS);

/** 408300 → "408.3k", 1200 → "1.2k", 1_000_000 → "1M" (trailing ".0" trimmed). */
function formatTokens(tokens: number): string {
  let text: string;
  if (tokens >= 1_000_000) text = `${(tokens / 1_000_000).toFixed(1)}M`;
  else if (tokens >= 1_000) text = `${(tokens / 1_000).toFixed(1)}k`;
  else text = String(Math.round(tokens));
  return text.replace(/\.0([kM])$/, "$1");
}

interface LegendEntry {
  key: string;
  tokens: number;
}

function flattenComposition(
  composition: NonNullable<import("@/stores/context-usage-store").LiveContextUsage["composition"]>,
): LegendEntry[] {
  const rows: LegendEntry[] = [];
  for (const key of BUCKET_ORDER) {
    if (key === "unattributed") continue;
    const bucket = composition[key as keyof typeof composition];
    const tokens = Array.isArray(bucket)
      ? bucket.reduce((sum, part) => sum + part.tokens, 0)
      : 0;
    if (tokens > 0) rows.push({ key, tokens });
  }
  if (composition.unattributedObservedTokens > 0) {
    rows.push({ key: "unattributed", tokens: composition.unattributedObservedTokens });
  }
  return rows;
}

export function ContextCard({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation();
  const live = useContextUsageStore((s) => (sessionId ? s.liveBySession[sessionId] : undefined));
  const snapshot = useContextUsageStore((s) =>
    sessionId ? s.compositionBySession[sessionId] : undefined,
  );

  const used = live?.usedTokens ?? snapshot?.usedTokens ?? 0;
  const window = live?.contextWindow ?? snapshot?.contextWindow ?? 0;
  const composition = snapshot?.composition ?? live?.composition ?? null;
  if (!window || window <= 0) return null;
  const legend = composition ? flattenComposition(composition) : [];
  if (legend.length === 0 && used <= 0) return null;

  const percent = Math.min(100, (used / window) * 100);
  const freeTokens = Math.max(0, window - used);
  const total = used + freeTokens;

  return (
    <section className="task-card-section rail-card" data-testid="rail-context-card">
      <div className="task-card-section-header">
        <div className="task-card-section-label">{t("panel.ctx.title")}</div>
      </div>
      <div className="rail-card-body">
        <div className="ctx-headline">
          <span className="ctx-percent">{Math.round(percent)}% used</span>
          <span className="ctx-window">
            {formatTokens(used)} / {formatTokens(window)}
          </span>
        </div>
        <div className="ctx-bar" role="img" aria-label={`${Math.round(percent)}% used`}>
          {legend.map((entry) => (
            <span
              key={entry.key}
              className="ctx-bar-seg"
              style={{
                flex: `${entry.tokens} 0 0`,
                background: BUCKET_COLORS[entry.key],
              }}
            />
          ))}
          {legend.length > 0 && (
            <span
              className="ctx-bar-seg ctx-bar-free"
              style={{ flex: `${freeTokens} 0 0` }}
            />
          )}
        </div>
        <div className="ctx-legend">
          {legend.map((entry) => (
            <div key={entry.key} className="ctx-legend-row">
              <span
                className="ctx-legend-swatch"
                style={{ background: BUCKET_COLORS[entry.key] }}
              />
              <span className="ctx-legend-name">{t(BUCKET_LABEL_KEYS[entry.key])}</span>
              <span className="ctx-legend-tokens">{formatTokens(entry.tokens)}</span>
              <span className="ctx-legend-share">
                {((entry.tokens / total) * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
