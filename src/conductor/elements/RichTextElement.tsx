"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ElementComponentProps } from "./ElementRegistry";
import { EmptyElement } from "./EmptyElement";

export const RichTextElement: React.FC<ElementComponentProps> = ({ element }) => {
  const content = (element.vizSpec?.payload?.content as string) ?? "";
  if (!content) return <EmptyElement element={element} />;

  return (
    <div className="rich-text-element prose prose-sm max-w-none p-3 text-[var(--text)] text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
};