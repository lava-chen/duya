import React, { useState } from 'react';
import { CodeBlock } from './CodeBlock';
import { openLocalArtifactTarget, isLikelyLocalFileReference, isLocalhostUrl, fileNameFromPath } from '@/lib/chat-file-links';
import { useConversationStore } from '@/stores/conversation-store';
import { ImagePreviewModal } from './ImagePreviewModal';
import { FileIcon } from '../icons';

// Inline media: renders <img> thumbnails that open the lightbox on click,
// or <video controls> elements for common video extensions so the same
// `![alt](url)` syntax handles both. External URLs load directly via the
// Electron renderer; absolute filesystem paths route through the
// `duya-file://` custom protocol so the renderer can read local files.
const VIDEO_EXT_RE = /\.(mp4|webm|mov|ogg|m4v)(?:\?|#|$)/i;

// Detect a Windows absolute path like `C:/...` or `C:\...`. Unix
// absolute paths start with `/`; the renderer treats `/...` as a URL
// scheme so we must distinguish "filesystem path" from "URL with a
// weird scheme".
function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}
function isUnixAbsolutePath(value: string): boolean {
  return value.startsWith('/');
}

/**
 * Rewrite a markdown image `src` so the renderer can actually load it.
 * Standard web URLs pass through unchanged. Absolute filesystem paths
 * are mapped to the `duya-file://` custom protocol registered in the
 * Electron main process; agents never have to write `duya-file://`
 * themselves.
 */
function rewriteMediaSrc(src: string): string {
  if (!src) return src;
  // Windows absolute paths look like `C:/...` or `C:\...` — the `C:`
  // prefix could be mistaken for a URL scheme, so check this first.
  if (isWindowsAbsolutePath(src)) {
    return `duya-file:///${src.replace(/\\/g, '/')}`;
  }
  // Scheme-bearing URL (`http:`, `https:`, `data:`, `blob:`, ...) passes
  // through. Anything else that begins with `/` is a Unix absolute path.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return src;
  if (isUnixAbsolutePath(src)) {
    return `duya-file://${src}`;
  }
  return src;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  const altText = alt ?? '';
  const resolvedSrc = rewriteMediaSrc(src);

  if (VIDEO_EXT_RE.test(resolvedSrc)) {
    return (
      <video
        controls
        preload="metadata"
        className="markdown-video"
        aria-label={altText || 'video'}
      >
        <source src={resolvedSrc} />
      </video>
    );
  }

  return (
    <>
      <button
        type="button"
        className="markdown-image-button"
        onClick={() => setOpen(true)}
        aria-label={`Enlarge image: ${altText}`}
      >
        <img src={resolvedSrc} alt={altText} className="markdown-image" loading="lazy" />
        {altText && (
          <span className="markdown-image-caption">{altText}</span>
        )}
      </button>
      {open && (
        <ImagePreviewModal
          src={resolvedSrc}
          alt={altText || 'image'}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// Match a bare filename or filename with a line suffix, e.g. `network.py`
// or `network.py:12`. We deliberately exclude anything that contains a slash
// or a scheme so we can fall back to the normal link logic for real paths.
const BARE_FILE_REFERENCE_RE = /^[^/\\:?#\s]+\.\w+(?::\d+)?$/;

function MarkdownAnchor({ href, children }: { href?: string; children?: React.ReactNode }) {
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const threads = useConversationStore((s) => s.threads);
  const cwd = threads.find((thread) => thread.id === activeThreadId)?.workingDirectory;

  // If the model only wrote a bare filename (e.g. `network.py` or
  // `network.py:12`) and we know the working directory, resolve it against
  // the workspace root so it still renders as a clickable file pill. This
  // is a renderer-side safety net for models that fail to supply an
  // absolute or relative path.
  let resolvedHref = href;
  let isBareFileName = false;
  if (typeof href === 'string' && cwd && BARE_FILE_REFERENCE_RE.test(href)) {
    const separator = /[\\/]/.test(cwd) ? cwd.match(/[\\/]/)?.[0] ?? '/' : '/';
    resolvedHref = `${cwd.replace(/[\\/]+$/, '')}${separator}${href}`;
    isBareFileName = true;
  }

  const isLocalFile = typeof resolvedHref === 'string' && isLikelyLocalFileReference(resolvedHref);
  // Localhost URLs (e.g. `http://localhost:8000/`) flow into the
  // side-panel browser instead of an external tab. External http(s)
  // keeps the default target=_blank behaviour.
  const isLocalServer = typeof href === 'string' && isLocalhostUrl(href);

  if (isLocalServer && href) {
    return (
      <button
        type="button"
        className="text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 transition-colors font-mono text-[13.5px] bg-blue-500/5 hover:bg-blue-500/10 px-1 py-0.5 rounded border border-blue-500/20 cursor-pointer"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('duya:open-browser-panel', {
            detail: { url: href },
          }));
        }}
        title={`Open in DUYA browser: ${href}`}
      >
        {children}
      </button>
    );
  }

  // Local file references render as a pill: file icon + blue filename.
  // The raw link target may be a full path with a line suffix; the visible
  // text should be the clean filename (matching the iconography users see
  // in the rest of the DUYA UI).
  if (isLocalFile && resolvedHref) {
    const displayName = fileNameFromPath(resolvedHref);
    return (
      <button
        type="button"
        className="markdown-file-link"
        onClick={() => openLocalArtifactTarget(resolvedHref, cwd)}
        title={resolvedHref}
      >
        <FileIcon size={16} weight="regular" aria-hidden="true" />
        <span className="markdown-file-link__name">{displayName}</span>
      </button>
    );
  }

  return (
    <a
      href={href}
      className="text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 transition-colors"
      target='_blank'
      rel='noopener noreferrer'
    >
      {children}
    </a>
  );
}

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
  a: MarkdownAnchor,
  img: MarkdownImage,
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
          style={{
            fontFamily: "'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
          }}
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
    <div className="markdown-table-scroll scrollbar-thin">
      <table className="markdown-table">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: React.ReactNode }) => <tr>{children}</tr>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="markdown-table__heading">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="markdown-table__cell">{children}</td>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
};
