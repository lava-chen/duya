/**
 * BotCodeBlock — Code block with syntax-highlighted display and one-click copy.
 *
 * Matches grok-bot's sand-code-block styling:
 *   - Dark background (#1a1d19)
 *   - Language label top-left
 *   - Copy button top-right (changes to CheckIcon on success)
 *   - Scrollable pre if content overflows
 *
 * Note: lightweight implementation — no external syntax highlighter.
 * Simple token-coloring for a few common languages (js, ts, python, bash, json, html, css, sql).
 */

import React, { useState } from 'react';
import { CopyIcon, CheckIcon } from '@/components/icons';

interface BotCodeBlockProps {
  code: string;
  language?: string;
}

/** Simple tokenizer for basic syntax highlighting. */
function tokenize(code: string, lang: string): React.ReactNode[] {
  const lines = code.split('\n');
  return lines.map((line, lineIndex) => {
    const tokens: React.ReactNode[] = [];
    let remaining = line;
    let keyIndex = 0;

    // Simple keyword + string + comment patterns
    const patterns: [RegExp, string][] = [
      // Strings (double/single quotes)
      [/^"([^"\\]|\\.)*"/, 'tok-string'],
      [/^'([^'\\]|\\.)*'/, 'tok-string'],
      // Comments
      [/^\/\/.*/, 'tok-comment'],
      [/^#.*/, 'tok-comment'],
      [/^--.*/, 'tok-comment'],
      // Numbers
      [/^\b\d+\.?\d*\b/, 'tok-number'],
      // Keywords (common sets)
      ...(lang === 'python'
        ? ([[/^\b(def|class|import|from|if|elif|else|for|while|return|print|True|False|None|and|or|not|in|is|with|as|lambda|yield|async|await|pass|break|continue|raise|try|except|finally|assert)\b/, 'tok-keyword']] as [RegExp, string][])
        : lang === 'bash'
        ? ([[/^\b(function|if|then|else|fi|for|do|done|while|esac|case|return|echo|export|source|cd|ls|grep|sed|awk|cat|mkdir|rm|cp|mv|chmod|chown|curl|wget|pip|npm|git|ssh|scp|eval|local|declare|readonly)\b/, 'tok-keyword']] as [RegExp, string][])
        : ([[/^\b(const|let|var|function|class|if|else|for|while|return|import|export|from|default|async|await|new|this|super|static|get|set|typeof|instanceof|null|undefined|true|false|void|yield|try|catch|finally|throw|const|interface|type|enum|implements|extends|public|private|protected|readonly|abstract|override)\b/, 'tok-keyword']] as [RegExp, string][])),
    ];

    while (remaining.length > 0) {
      let matched = false;

      for (const [regex, cls] of patterns) {
        const m = remaining.match(regex);
        if (m) {
          tokens.push(
            <span key={`${lineIndex}-${keyIndex++}`} className={cls}>
              {m[0]}
            </span>
          );
          remaining = remaining.slice(m[0].length);
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Collect until next potential token or end of line
        const nextMatch = remaining.search(/["'/#\d]|\\b\w+\\b/);
        if (nextMatch <= 0) {
          tokens.push(remaining);
          break;
        } else {
          tokens.push(remaining.slice(0, nextMatch));
          remaining = remaining.slice(nextMatch);
        }
      }
    }

    return (
      <div key={lineIndex} className="tok-line">
        {tokens}
      </div>
    );
  });
}

const LANG_LABELS: Record<string, string> = {
  js: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TSX',
  jsx: 'JSX',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
  swift: 'Swift',
  kt: 'Kotlin',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  ps1: 'PowerShell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  md: 'Markdown',
  mdx: 'MDX',
  mermaid: 'Mermaid',
  graphql: 'GraphQL',
  dockerfile: 'Dockerfile',
};

export function BotCodeBlock({ code, language }: BotCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const lang = (language || '').toLowerCase().trim();
  const langLabel = lang in LANG_LABELS ? LANG_LABELS[lang] : language || 'code';
  const isMermaid = lang === 'mermaid';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  return (
    <div className="bot-code-block">
      <div className="bot-code-block__header">
        <span className="bot-code-block__lang">{langLabel}</span>
        <button
          type="button"
          className="bot-code-block__copy"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied!' : 'Copy code'}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="bot-code-block__scroll">
        {isMermaid ? (
          // Mermaid diagrams are rendered as plain text — the renderer would
          // handle a mermaid component if available. For now, show as code.
          <pre className="bot-code-block__pre"><code>{code}</code></pre>
        ) : (
          <pre className="bot-code-block__pre">
            <code>{tokenize(code, lang)}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
