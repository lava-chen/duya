// ToolResultRenderer.tsx - Smart tool result rendering

'use client';

import React from 'react';
import { FileIcon, ChromeIcon, ArrowRightIcon, RobotIcon } from '@/components/icons';
import { SimpleDiffViewer } from '@/components/diff/SimpleDiffViewer';
import { CodeViewer } from '@/components/diff/CodeViewer';

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface ToolUseInfo {
  id?: string;
  name: string;
  input: unknown;
}

// Note: SearchResult interface removed - web_search tool disabled
// interface SearchResult {
//   title: string;
//   url: string;
//   snippet: string;
// }

// ---------------------------------------------------------------------------
// Tool-specific renderers
// ---------------------------------------------------------------------------

interface ToolResultRenderer {
  canRender: (name: string, content: string) => boolean;
  render: (name: string, content: string) => React.ReactNode;
}

/**
 * GlobTool result renderer
 * Parses: { durationMs, numFiles, truncated, filenames: [...] }
 * Renders: "32 files" + file list
 */
const globRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    return name === 'glob' && content.includes('"filenames"') && content.includes('"numFiles"');
  },
  render: (name, content) => {
    try {
      const data = JSON.parse(content);
      const numFiles = data.numFiles as number;
      const filenames = data.filenames as string[];
      const truncated = data.truncated as boolean;

      if (numFiles === 0) {
        return <span className="text-muted-foreground">No files matched</span>;
      }

      const files = truncated ? filenames.slice(0, 10) : filenames.slice(0, 15);
      const moreCount = truncated ? filenames.length - 10 : filenames.length - 15;

      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{numFiles}</span>
            <span>file{numFiles !== 1 ? 's' : ''} matched</span>
            {truncated && <span className="text-amber-600">(truncated)</span>}
          </div>
          <div className="bg-muted/30 rounded p-2 font-mono text-[11px] leading-relaxed max-h-[180px] overflow-auto">
            {files.map((f: string, i: number) => (
              <div key={i} className="truncate pr-2" title={f}>
                {f}
              </div>
            ))}
            {moreCount > 0 && (
              <div className="text-muted-foreground/50 mt-1">
                ... and {moreCount} more
              </div>
            )}
          </div>
        </div>
      );
    } catch {
      return null;
    }
  },
};

/**
 * GrepTool result renderer
 * Parses: { numFiles, filenames: [...] } or { mode, numMatches, content }
 * Renders: "12 matches across 5 files"
 */
const grepRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    return (name === 'grep' || name === 'search') && content.includes('"numFiles"');
  },
  render: (name, content) => {
    try {
      const data = JSON.parse(content);
      const numFiles = data.numFiles as number;
      const filenames = data.filenames as string[];

      if (numFiles === 0) {
        return <span className="text-muted-foreground">No matches found</span>;
      }

      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{filenames.length}</span>
            <span>file{filenames.length !== 1 ? 's' : ''} with matches</span>
          </div>
          <div className="bg-muted/30 rounded p-2 font-mono text-[11px] leading-relaxed max-h-[180px] overflow-auto">
            {filenames.slice(0, 15).map((f: string, i: number) => (
              <div key={i} className="truncate pr-2" title={f}>
                {f}
              </div>
            ))}
            {filenames.length > 15 && (
              <div className="text-muted-foreground/50 mt-1">
                ... and {filenames.length - 15} more
              </div>
            )}
          </div>
        </div>
      );
    } catch {
      return null;
    }
  },
};

/**
 * ReadTool result renderer
 * Shows: file path + preview of content with syntax highlighting
 */
const readRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    return ['read', 'readfile', 'read_file'].includes(name.toLowerCase());
  },
  render: (name, content) => {
    try {
      // Try to detect if it's JSON (file listing) or plain text
      const trimmed = content.trim();

      // If it looks like JSON array of paths
      if (trimmed.startsWith('[')) {
        const paths = JSON.parse(trimmed);
        if (Array.isArray(paths)) {
          return (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{paths.length}</span> files
              </div>
              <div className="bg-muted/30 rounded p-2 font-mono text-[11px] leading-relaxed max-h-[150px] overflow-auto">
                {paths.slice(0, 20).map((f: string, i: number) => (
                  <div key={i} className="truncate pr-2">{f}</div>
                ))}
                {paths.length > 20 && (
                  <div className="text-muted-foreground/50">... and {paths.length - 20} more</div>
                )}
              </div>
            </div>
          );
        }
      }

      // Check if content has file header pattern (File: path\nLines: X-Y\n\ncontent)
      const fileHeaderMatch = trimmed.match(/^File:\s*(.+?)\s*\nLines:\s*(\d+)-(\d+)\s*\n\n([\s\S]+)$/);
      if (fileHeaderMatch) {
        const [, filePath, startLine, endLine, fileContent] = fileHeaderMatch;
        const startLineNum = parseInt(startLine);

        return (
          <div className="rounded-md border border-border/50 overflow-hidden bg-card">
            {/* Code content only - header removed, shown in toggle row */}
            <CodeViewer
              content={fileContent}
              startLine={startLineNum}
              maxHeight={400}
            />
          </div>
        );
      }

      // Plain text content
      return (
        <CodeViewer
          content={trimmed}
          startLine={1}
          maxHeight={400}
        />
      );
    } catch {
      // Not JSON, show as plain text
      return (
        <CodeViewer
          content={content.trim()}
          startLine={1}
          maxHeight={400}
        />
      );
    }
  },
};

// Helper function to get language name from file extension
function getLanguageFromExt(ext: string): string {
  const langMap: Record<string, string> = {
    'js': 'JavaScript',
    'ts': 'TypeScript',
    'tsx': 'TypeScript React',
    'jsx': 'JavaScript React',
    'py': 'Python',
    'json': 'JSON',
    'md': 'Markdown',
    'css': 'CSS',
    'scss': 'SCSS',
    'html': 'HTML',
    'xml': 'XML',
    'yaml': 'YAML',
    'yml': 'YAML',
    'toml': 'TOML',
    'rs': 'Rust',
    'go': 'Go',
    'java': 'Java',
    'cpp': 'C++',
    'c': 'C',
    'h': 'C Header',
    'hpp': 'C++ Header',
    'rb': 'Ruby',
    'php': 'PHP',
    'sh': 'Shell',
    'bash': 'Bash',
    'zsh': 'Zsh',
    'sql': 'SQL',
    'dockerfile': 'Dockerfile',
    'vue': 'Vue',
    'svelte': 'Svelte',
  };
  return langMap[ext] || ext.toUpperCase() || 'Text';
}

/**
 * LS result renderer
 * Parses directory listing output
 */
const lsRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    return name === 'ls' && (content.includes('\n') || content.startsWith('['));
  },
  render: (name, content) => {
    let items: string[] = [];

    try {
      // Try JSON array first
      if (content.trim().startsWith('[')) {
        items = JSON.parse(content);
      } else {
        // Parse as newline-separated list
        items = content.trim().split('\n').filter(Boolean);
      }
    } catch {
      items = content.trim().split('\n').filter(Boolean);
    }

    if (items.length === 0) {
      return <span className="text-muted-foreground">Empty directory</span>;
    }

    return (
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{items.length}</span> items
        </div>
        <div className="bg-muted/30 rounded p-2 font-mono text-[11px] leading-relaxed max-h-[150px] overflow-auto">
          {items.slice(0, 25).map((f: string, i: number) => (
            <div key={i} className="truncate pr-2">{f}</div>
          ))}
          {items.length > 25 && (
            <div className="text-muted-foreground/50">... and {items.length - 25} more</div>
          )}
        </div>
      </div>
    );
  },
};

/**
 * Bash command result renderer
 * Parses and shows exit status + output
 */
const bashRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    return ['bash', 'shell', 'execute', 'run'].includes(name.toLowerCase());
  },
  render: (name, content) => {
    // Check for error indicators
    const isError = content.includes('<tool_error>') || content.includes('command failed');

    if (isError) {
      return (
        <div className="bg-red-500/10 rounded p-2 font-mono text-[11px] text-red-500 whitespace-pre-wrap max-h-[150px] overflow-auto">
          {content}
        </div>
      );
    }

    // Show last few lines of output
    const lines = content.trim().split('\n').slice(-8);
    return (
      <div className="bg-muted/30 rounded p-2 font-mono text-[11px] text-muted-foreground/80 whitespace-pre-wrap max-h-[150px] overflow-auto">
        {lines.join('\n')}
      </div>
    );
  },
};

/**
 * Edit tool result renderer
 * Shows diff view for file edits
 */
const editRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    const lowerName = name.toLowerCase();
    return (lowerName === 'edit' || lowerName === 'edit_file' || lowerName === 'str_replace_editor') &&
           (content.includes('Changed:') || content.includes('Successfully edited'));
  },
  render: (name, content) => {
    try {
      // Parse the edit result format: "Successfully edited {file_path}\n\nChanged:\n{old_string}\n\nTo:\n{new_string}"
      const changedMatch = content.match(/Changed:\n([\s\S]+?)\n\nTo:\n([\s\S]+)$/);
      if (changedMatch) {
        const filePathMatch = content.match(/Successfully edited (.+)\n/);
        const filePath = filePathMatch ? filePathMatch[1] : 'unknown';
        const oldContent = changedMatch[1];
        const newContent = changedMatch[2];

        return (
          <SimpleDiffViewer
            oldContent={oldContent}
            newContent={newContent}
            maxHeight={400}
          />
        );
      }

      // Try JSON format as fallback
      const data = JSON.parse(content);

      // Handle edit result with diff
      if (data.diff || (data.old_string && data.new_string)) {
        const oldContent = data.old_string || data.oldContent || '';
        const newContent = data.new_string || data.newContent || data.diff || '';

        return (
          <SimpleDiffViewer
            oldContent={oldContent}
            newContent={newContent}
            maxHeight={400}
          />
        );
      }

      // Handle multi-edit results
      if (data.edits && Array.isArray(data.edits)) {
        return (
          <div className="space-y-3">
            {data.edits.map((edit: { old_string: string; new_string: string }, idx: number) => (
              <SimpleDiffViewer
                key={idx}
                oldContent={edit.old_string}
                newContent={edit.new_string}
                maxHeight={300}
              />
            ))}
          </div>
        );
      }

      return null;
    } catch {
      return null;
    }
  },
};

/**
 * Write tool result renderer
 * Shows diff for new files or file overwrites
 */
const writeRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    const lowerName = name.toLowerCase();
    return (lowerName === 'write' || lowerName === 'write_file') &&
           (content.includes('content') || content.includes('file_path'));
  },
  render: (name, content) => {
    try {
      const data = JSON.parse(content);

      if (data.content && data.file_path) {
        const filePath = data.file_path;
        const newContent = data.content;
        const oldContent = data.previous_content || '';

        // If there's previous content, show diff
        if (oldContent) {
          return (
            <SimpleDiffViewer
              oldContent={oldContent}
              newContent={newContent}
              maxHeight={400}
            />
          );
        }

        // New file - show content preview
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const language = getLanguageFromExt(ext);

        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2 pb-2 border-b border-border/30">
              <FileIcon size={14} className="text-green-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-foreground truncate" title={filePath}>
                  {fileName}
                </div>
                <div className="text-[10px] text-green-600">
                  New file • {language}
                </div>
              </div>
            </div>
            <div className="relative bg-[#0d1117] rounded-lg overflow-hidden">
              <div className="flex max-h-[200px] overflow-auto">
                <div className="shrink-0 py-2 px-2 text-right bg-[#161b22] border-r border-[#30363d]">
                  {newContent.split('\n').slice(0, 15).map((_: string, i: number) => (
                    <div key={i} className="text-[10px] text-[#484f58] leading-5 font-mono">
                      {i + 1}
                    </div>
                  ))}
                </div>
                <div className="flex-1 py-2 px-3 overflow-x-auto">
                  <pre className="text-[11px] leading-5 font-mono whitespace-pre">
                    <code className="text-[#e6edf3]">
                      {newContent.split('\n').slice(0, 15).join('\n')}
                    </code>
                  </pre>
                  {newContent.split('\n').length > 15 && (
                    <div className="text-[10px] text-muted-foreground/50 mt-1 pt-1 border-t border-border/20">
                      ... {newContent.split('\n').length - 15} more lines
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      }

      return null;
    } catch {
      return null;
    }
  },
};

/**
 * Agent tool result renderer
 * Shows sub-agent execution result with agent type, description, and content
 */
const agentRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    const lowerName = name.toLowerCase();
    return (lowerName === 'agent' || lowerName === 'task') && content.includes('"agentType"') && content.includes('"content"');
  },
  render: (name, content) => {
    try {
      const data = JSON.parse(content);

      // Error state from agent execution
      if (data.error) {
        return (
          <div className="bg-red-500/10 rounded p-2 font-mono text-[11px] text-red-500 whitespace-pre-wrap max-h-[200px] overflow-auto">
            {data.error}
          </div>
        );
      }

      const agentType = data.resolvedAgentType || data.agentType || 'Agent';
      const description = data.description || '';
      const agentContent = data.content || '';

      // Format agent type for display (capitalize each word)
      const displayAgentType = agentType
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .split(/\s+/)
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      return (
        <div className="rounded-md border border-border/50 overflow-hidden bg-card">
          {/* Agent header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border/50">
            <RobotIcon size={14} className="text-muted-foreground shrink-0" />
            <span className="text-xs font-medium">{displayAgentType}</span>
            {description && (
              <>
                <span className="text-muted-foreground/60 text-[11px]">•</span>
                <span className="text-[11px] text-muted-foreground truncate">{description}</span>
              </>
            )}
          </div>

          {/* Agent content */}
          <div className="p-3 font-mono text-[11px] whitespace-pre-wrap max-h-[400px] overflow-auto leading-relaxed text-muted-foreground">
            {agentContent}
          </div>
        </div>
      );
    } catch {
      return null;
    }
  },
};

/**
 * Browser tool result renderer
 * Shows fallback mode warning when extension is not installed
 */
const browserRenderer: ToolResultRenderer = {
  canRender: (name, content) => {
    const lowerName = name.toLowerCase();
    return lowerName === 'browser' || lowerName === 'browsertool';
  },
  render: (name, content) => {
    try {
      const data = JSON.parse(content);

      // Check if running in fallback mode
      const isFallback = data.mode === 'fallback';
      const hasError = data.error && (
        data.error.includes('fallback') ||
        data.error.includes('Extension') ||
        data.error.includes('not available')
      );

      // Show fallback mode warning banner
      if (isFallback || hasError) {
        return (
          <div className="space-y-3">
            {/* Fallback mode warning banner */}
            <div
              className="flex items-start gap-3 p-3 rounded-xl"
              style={{
                backgroundColor: 'rgba(251, 191, 36, 0.08)',
                border: '1px solid rgba(251, 191, 36, 0.25)',
              }}
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                style={{ backgroundColor: 'rgba(251, 191, 36, 0.15)' }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ color: '#f59e0b' }}
                >
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>
                  Limited Mode: Browser Extension Not Installed
                </p>
                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Running in fallback mode. Interactive features like clicking, typing, screenshots,
                  and JavaScript execution are unavailable. Install the DUYA Browser Bridge extension for full functionality.
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={() => window.open('chrome://extensions/', '_blank')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] transition-colors hover:opacity-90"
                    style={{
                      backgroundColor: 'rgba(94, 109, 255, 0.15)',
                      color: 'var(--accent)',
                    }}
                  >
                    <ChromeIcon size={12} />
                    Install Extension
                    <ArrowRightIcon size={12} />
                  </button>
                </div>
              </div>
            </div>

            {/* Show the actual result content */}
            <div className="bg-muted/30 rounded p-2 font-mono text-[11px] whitespace-pre-wrap max-h-[200px] overflow-auto">
              {JSON.stringify(data, null, 2)}
            </div>
          </div>
        );
      }

      // Normal browser tool result - show as JSON
      return (
        <div className="bg-muted/30 rounded p-2 font-mono text-[11px] whitespace-pre-wrap max-h-[200px] overflow-auto">
          {JSON.stringify(data, null, 2)}
        </div>
      );
    } catch {
      return null;
    }
  },
};

/**
 * WebSearch result renderer (disabled - tool removed)
 * Kept as placeholder for future redesign
 */
// const webSearchRenderer: ToolResultRenderer = {
//   canRender: (name, content) => {
//     const lowerName = name.toLowerCase();
//     return (lowerName === 'web_search' || lowerName === 'websearch') && 
//            (content.includes('"results"') || content.includes('"title"') && content.includes('"url"'));
//   },
//   render: (name, content) => { ... }
// };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const renderers: ToolResultRenderer[] = [
  // webSearchRenderer, // Disabled - tool removed
  agentRenderer,
  browserRenderer,
  editRenderer,
  writeRenderer,
  globRenderer,
  grepRenderer,
  readRenderer,
  lsRenderer,
  bashRenderer,
];

function findRenderer(name: string, content: string): ToolResultRenderer | null {
  return renderers.find((r) => r.canRender(name, content)) || null;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

interface ToolResultRendererProps {
  tool: ToolUseInfo;
  result: ToolResultInfo;
}

/**
 * Smart tool result renderer
 * Renders tool results with appropriate formatting based on tool type
 */
export function renderToolResult(tool: ToolUseInfo, result: ToolResultInfo): React.ReactNode {
  const { name } = tool;
  const { content, is_error } = result;

  // Error state
  if (is_error) {
    return (
      <div className="bg-red-500/10 rounded p-2 font-mono text-[11px] text-red-500 whitespace-pre-wrap max-h-[200px] overflow-auto">
        {content}
      </div>
    );
  }

  // Try tool-specific renderer
  const renderer = findRenderer(name, content);
  if (renderer) {
    const rendered = renderer.render(name, content);
    if (rendered) return rendered;
  }

  // Fallback: try to render as structured data
  try {
    const data = JSON.parse(content);

    // Check for common patterns
    if (data.numFiles !== undefined || data.filenames !== undefined) {
      return globRenderer.render(name, content);
    }

    if (data.numMatches !== undefined) {
      return grepRenderer.render(name, content);
    }

    // Unknown structure - show raw
    return (
      <div className="bg-muted/30 rounded p-2 font-mono text-[11px] whitespace-pre-wrap max-h-[200px] overflow-auto">
        {JSON.stringify(data, null, 2)}
      </div>
    );
  } catch {
    // Not JSON, show raw content
    return (
      <div className="bg-muted/30 rounded p-2 font-mono text-[11px] whitespace-pre-wrap max-h-[200px] overflow-auto">
        {content}
      </div>
    );
  }
}
