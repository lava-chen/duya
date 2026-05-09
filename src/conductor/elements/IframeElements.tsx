"use client";

import React from "react";
import type { ElementComponentProps } from "./ElementRegistry";
import { MiniSandbox } from "@/components/conductor/MiniSandbox";
import { EmptyElement } from "./EmptyElement";

export const DiagramElement: React.FC<ElementComponentProps> = ({ element }) => {
  const payload = element.vizSpec?.payload;
  if (!payload) return <EmptyElement element={element} />;

  const type = (payload.type as string) ?? "mermaid";
  const content = (payload.content as string) ?? "";
  const darkMode = (payload.darkMode as boolean) ?? false;

  if (!content) return <EmptyElement element={element} />;

  const mermaidTheme = darkMode ? "dark" : "default";

  if (type === "mermaid") {
    const html = `<div class="mermaid">${content}</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: '${mermaidTheme}' });</script>`;

    return <MiniSandbox html={html} />;
  }

  return <MiniSandbox html={content} />;
};

export const ChartElement: React.FC<ElementComponentProps> = ({ element }) => {
  const payload = element.vizSpec?.payload;
  if (!payload) return <EmptyElement element={element} />;

  const chartType = (payload.chartType as string) ?? "bar";
  const labels = payload.labels as string[] | undefined;
  const datasets = payload.datasets as Array<Record<string, unknown>> | undefined;
  const showLegend = (payload.options as Record<string, unknown> | undefined)?.showLegend ?? true;
  const yAxisLabel = ((payload.options as Record<string, unknown> | undefined)?.yAxisLabel as string) ?? "";

  if (!labels || !datasets) return <EmptyElement element={element} />;

  const chartConfig = JSON.stringify({ labels, datasets, showLegend, yAxisLabel });

  const html = `<canvas id="chart" style="width:100%;height:100%;"></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
(function() {
  var ctx = document.getElementById('chart').getContext('2d');
  var cfg = ${chartConfig};
  new Chart(ctx, {
    type: '${chartType}',
    data: { labels: cfg.labels, datasets: cfg.datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: cfg.showLegend } },
      scales: { y: { title: { display: !!'${yAxisLabel}', text: '${yAxisLabel}' } } }
    }
  });
})();
</script>`;

  return <MiniSandbox html={html} />;
};

export const CardElement: React.FC<ElementComponentProps> = ({ element }) => {
  const payload = element.vizSpec?.payload;
  if (!payload) return <EmptyElement element={element} />;

  const title = (payload.title as string) ?? "";
  const subtitle = (payload.subtitle as string) ?? "";
  const body = (payload.body as string) ?? "";
  const imageUrl = (payload.imageUrl as string) ?? "";
  const tags = payload.tags as string[] | undefined;
  const footer = (payload.footer as string) ?? "";

  const tagsHtml = tags?.length
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">${tags
        .map((t) => `<span style="padding:2px 8px;border-radius:12px;background:var(--bg-hover);font-size:11px;color:var(--text-secondary);">${t}</span>`)
        .join("")}</div>`
    : "";

  const imageHtml = imageUrl
    ? `<img src="${imageUrl}" alt="" style="width:100%;border-radius:8px;margin-bottom:12px;" />`
    : "";

  const html = `<div class="card-content" style="padding:12px;color:var(--text);">
  ${imageHtml}
  ${title ? `<h3 style="margin:0 0 4px;font-size:15px;font-weight:600;color:var(--text);">${title}</h3>` : ""}
  ${subtitle ? `<p style="margin:0 0 8px;font-size:12px;color:var(--text-secondary);">${subtitle}</p>` : ""}
  ${body ? `<p style="margin:0;font-size:13px;line-height:1.6;color:var(--text);">${body}</p>` : ""}
  ${tagsHtml}
  ${footer ? `<p style="margin:12px 0 0;font-size:11px;color:var(--muted);border-top:1px solid var(--border);padding-top:8px;">${footer}</p>` : ""}
</div>`;

  return <MiniSandbox html={html} />;
};

export const ImageElement: React.FC<ElementComponentProps> = ({ element }) => {
  const payload = element.vizSpec?.payload;
  if (!payload) return <EmptyElement element={element} />;

  const src = (payload.src as string) ?? "";
  const alt = (payload.alt as string) ?? "";
  if (!src) return <EmptyElement element={element} />;

  const html = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;">
  <img src="${src}" alt="${alt}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;" />
</div>`;

  return <MiniSandbox html={html} />;
};

export const MiniAppElement: React.FC<ElementComponentProps> = ({ element }) => {
  const payload = element.vizSpec?.payload;
  if (!payload) return <EmptyElement element={element} />;

  const appHtml = (payload.html as string) ?? "";
  const appJs = (payload.js as string) ?? "";
  const appCss = (payload.css as string) ?? "";

  if (!appHtml) return <EmptyElement element={element} />;

  return <MiniSandbox html={appHtml} js={appJs} css={appCss} />;
};