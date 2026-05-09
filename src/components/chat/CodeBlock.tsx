'use client';

import React, { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CopyIcon, CheckIcon, CheckCircleIcon } from '@/components/icons';
import { useTheme } from '@/hooks/useTheme';

interface CodeBlockProps {
  children: React.ReactNode;
  className?: string;
  copyLabel?: string;
  copiedLabel?: string;
}

export function CodeBlock({ children, className, copyLabel = 'Copy', copiedLabel = 'Copied' }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(String(children).replace(/\n$/, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  // Unified background color and border color for the entire code block
  const bgColor = isDark ? 'bg-[#1e1e1e]' : 'bg-[#f8f9fa]';
  const borderColor = isDark ? 'border-[#444441]' : 'border-[#d4d4d3]';

  return (
    <div className={`relative group rounded-lg overflow-hidden border ${borderColor} ${bgColor}`}>
      <div className={`flex items-center justify-between px-4 py-2 text-xs ${bgColor} ${isDark ? 'text-[#8b949e]' : 'text-muted-foreground/70'}`}>
        <span className="font-medium" style={{ fontFamily: "'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>{language || 'text'}</span>
        <button
          onClick={copyCode}
          className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${isDark ? 'hover:bg-[#333333]' : 'hover:bg-muted/50'}`}
        >
          {copied ? (
            <>
              <CheckCircleIcon size={12} className="text-green-500" />
              <span className="text-green-500 font-medium">{copiedLabel}</span>
            </>
          ) : (
            <>
              <CopyIcon size={12} />
              <span>{copyLabel}</span>
            </>
          )}
        </button>
      </div>
      <div className={`p-4 overflow-x-auto ${bgColor}`}>
        <SyntaxHighlighter
          language={language || 'text'}
          style={isDark ? oneDark : oneLight}
          customStyle={{
            margin: 0,
            padding: 0,
            background: 'transparent',
            fontSize: '13px',
            lineHeight: '1.7',
          }}
          codeTagProps={{
            style: {
              fontFamily: "'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            },
          }}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
