import React from 'react';
import { CodeBlock } from './CodeBlock';

export const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-2xl font-bold text-foreground mt-8 mb-4 pb-2 border-b border-border/50">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-xl font-bold text-foreground mt-6 mb-3">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-lg font-semibold text-foreground mt-5 mb-2">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="text-[15px] text-foreground leading-[1.65] mb-2">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-outside text-[15px] text-foreground mb-4 pl-5 space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-outside text-[15px] text-foreground mb-4 pl-5 space-y-1">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-[15px] text-foreground leading-[1.65] pl-1">{children}</li>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} className="text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 transition-colors" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  code: ({ children, className, ...props }: { children?: React.ReactNode; className?: string }) => {
    const match = /language-(\w+)/.exec(className || '');
    const raw = String(children ?? '');
    const hasNewline = raw.includes('\n');
    const isBlock = hasNewline || match;

    if (!isBlock) {
      // Strip backticks that may be included in the content
      let textContent = raw.trim();
      while (textContent.startsWith('`')) textContent = textContent.slice(1);
      while (textContent.endsWith('`')) textContent = textContent.slice(0, -1);

      return (
        <code
          className="px-[0.35rem] py-[0.15rem] rounded-[4px] text-[13.5px] font-normal text-[#b487e0] dark:text-[#a87ad6]"  
          style={{ fontFamily: "'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
          {...props}
        >
          {textContent}
        </code>
      );
    }

    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-4 code-block-wrapper">{children}</div>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-[3px] border-muted-foreground/30 pl-4 my-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border/50 my-3" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-1 scrollbar-thin">
      <table className="w-full text-[15px] text-left border-collapse border-spacing-0">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="border-b border-foreground/30">{children}</thead>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => (
    <tbody className="border-b border-foreground/30">{children}</tbody>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="border-b border-foreground/20 last:border-b-0">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3 py-2 font-semibold text-foreground text-left">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3 py-2 text-foreground align-top">{children}</td>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
};
