"use client";

import { Newspaper, CalendarBlank, Tag } from "@phosphor-icons/react";
import type { WidgetComponentProps, WidgetDefinition } from "./registry";

interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  category: string;
  time: string;
}

interface NewsData {
  articles: NewsArticle[];
  lastUpdated?: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  科技: "#3b82f6",
  财经: "#f59e0b",
  社会: "#10b981",
  国际: "#8b5cf6",
  体育: "#ef4444",
  娱乐: "#ec4899",
  生活: "#14b8a6",
};

function NewsBoardContent({ data, config }: WidgetComponentProps) {
  const newsData = (data as unknown as NewsData) || { articles: [] };
  const articles = newsData.articles || [];

  if (articles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--muted)]">
        <Newspaper size={32} weight="duotone" />
        <div className="text-xs text-center">
          <p>No news articles yet</p>
          <p className="opacity-50 mt-1">Ask the Agent "今天有什么新闻" to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 h-full">
      {newsData.lastUpdated && (
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
          <CalendarBlank size={10} />
          <span>更新于 {new Date(newsData.lastUpdated).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      )}

      {articles.map((article, idx) => {
        const catColor = CATEGORY_COLORS[article.category] || "var(--accent)";
        return (
          <div
            key={article.id || idx}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 transition-colors hover:border-[var(--accent-soft)] group"
          >
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <h4 className="text-xs font-semibold text-[var(--text)] leading-snug flex-1 line-clamp-2">
                {article.title}
              </h4>
              <span
                className="flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{
                  backgroundColor: catColor + "1a",
                  color: catColor,
                  border: `1px solid ${catColor}33`,
                }}
              >
                {article.category}
              </span>
            </div>
            <p className="text-[11px] text-[var(--muted)] leading-relaxed line-clamp-2 mb-1.5">
              {article.summary}
            </p>
            <div className="flex items-center gap-2 text-[9px] text-[var(--muted)] opacity-60">
              <span>{article.source}</span>
              <span className="w-1 h-1 rounded-full bg-[var(--muted)]" />
              <span>{article.time}</span>
            </div>
          </div>
        );
      })}

      <div className="mt-auto pt-2 text-[9px] text-[var(--muted)] opacity-40 text-center">
        {articles.length} articles · powered by DUYA Agent
      </div>
    </div>
  );
}

export const NewsBoardDefinition: WidgetDefinition = {
  kind: "builtin",
  type: "news-board",
  label: "News Board",
  description: "Newspaper-style news display",
  component: NewsBoardContent,
  defaultSize: { w: 6, h: 5 },
  minSize: { w: 3, h: 3 },
  defaultData: {
    articles: [],
    lastUpdated: "",
  },
  defaultConfig: {
    title: "📰 新闻看板",
  },
};
