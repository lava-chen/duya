"use client";

import { TrendUp, TrendDown, Minus } from "@phosphor-icons/react";
import type { WidgetComponentProps, WidgetDefinition } from "./registry";

interface MetricData {
  value: string;
  label: string;
  trend?: "up" | "down" | "flat";
  trendValue?: string;
  description?: string;
  prefix?: string;
  suffix?: string;
}

const TREND_CONFIG = {
  up: { Icon: TrendUp, color: "#22c55e" },
  down: { Icon: TrendDown, color: "#ef4444" },
  flat: { Icon: Minus, color: "#9ca3af" },
};

function MetricCardWidget({ data, config }: WidgetComponentProps) {
  const metric = (data as unknown as MetricData) || { value: "--", label: "Metric" };
  const trend = metric.trend || "flat";
  const { Icon: TrendIcon, color: trendColor } = TREND_CONFIG[trend];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <span className="text-[10px] font-medium text-[var(--muted)] uppercase tracking-wider">
        {metric.label}
      </span>
      <div className="flex items-baseline gap-1">
        {metric.prefix && (
          <span className="text-sm text-[var(--muted)]">{metric.prefix}</span>
        )}
        <span className="text-3xl font-bold text-[var(--text)] tabular-nums">
          {metric.value}
        </span>
        {metric.suffix && (
          <span className="text-sm text-[var(--muted)]">{metric.suffix}</span>
        )}
      </div>
      {metric.trendValue && (
        <div className="flex items-center gap-1" style={{ color: trendColor }}>
          <TrendIcon size={14} weight="bold" />
          <span className="text-xs font-medium">{metric.trendValue}</span>
        </div>
      )}
      {metric.description && (
        <span className="text-[10px] text-[var(--muted)] text-center leading-tight">
          {metric.description}
        </span>
      )}
    </div>
  );
}

export const MetricCardDefinition: WidgetDefinition = {
  kind: "builtin",
  type: "metric-card",
  label: "Metric Card",
  description: "Display a key metric with trend indicator",
  component: MetricCardWidget,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 2 },
  defaultData: {
    value: "3,240",
    label: "Active Users",
    trend: "up",
    trendValue: "+12.5%",
    description: "vs. previous week",
  },
  defaultConfig: {
    title: "📊 Metric",
  },
};