import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { markdownComponents } from './markdownComponents';

/**
 * Preprocess markdown text to fix bold syntax issues with text containing parentheses.
 *
 * micromark parser (used by react-markdown) doesn't recognize `**...**` bold when
 * the content contains parentheses like `**text (content)**`. This is a known
 * limitation in CommonMark spec handling of emphasis with punctuation.
 *
 * We work around it by inserting zero-width spaces (\u200B) inside the bold markers
 * when parentheses are detected within the bold content.
 */
export function preprocessMarkdownBold(text: string): string {
  // Match **...** patterns (non-greedy, single line)
  // Only fix those containing parentheses (full-width or half-width)
  return text.replace(/\*\*([^\n*]+?)\*\*/g, (match, content) => {
    if (/[（）()]/.test(content)) {
      return `**\u200B${content}\u200B**`;
    }
    return match;
  });
}

interface MarkdownRendererProps {
  children: string;
  className?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ children, className }) => {
  const processed = preprocessMarkdownBold(children);

  return (
    <div className={className || 'prose prose-sm max-w-none message-content'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
};
