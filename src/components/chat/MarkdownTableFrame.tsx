import { useCallback, useEffect, useRef, useState } from 'react';

import { CopyIcon, DownloadIcon, Maximize2Icon, XIcon } from '@/components/icons';
import { toast } from '@/components/ui/toast';
import {
  buildCsvTableText,
  buildMarkdownTableText,
  readRowsFromTable,
} from '@/lib/markdown-table-export';

/**
 * Chat markdown table with ZCode-style quick actions: copy as Markdown,
 * download as CSV (UTF-8 BOM + formula-injection guard), and a fullscreen
 * preview with a sticky header. The toolbar appears inside the table on
 * thead hover, positioned in the top-right corner — saving vertical space.
 */
export function MarkdownTableFrame({ children }: { children?: React.ReactNode }) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const readRows = useCallback(() => readRowsFromTable(tableRef.current), []);

  const handleCopyMarkdown = useCallback(async () => {
    const text = buildMarkdownTableText(readRows());
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已复制表格 Markdown');
    } catch {
      toast.error('复制失败：剪贴板不可用');
    }
  }, [readRows]);

  const handleDownloadCsv = useCallback(() => {
    const text = buildCsvTableText(readRows());
    if (!text) return;
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'table.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [readRows]);

  useEffect(() => {
    if (!previewOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewOpen]);

  // Show toolbar on thead hover. The toolbar lives inside the scroll
  // container alongside the table; we use mouseenter/mouseleave (not
  // :hover) so the toolbar stays visible while the cursor moves from
  // thead to the toolbar buttons without flicker.
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const thead = table.querySelector('thead');
    if (!thead) return;
    const onEnter = () => setToolbarVisible(true);
    const onLeave = (event: MouseEvent) => {
      const related = event.relatedTarget as HTMLElement | null;
      if (related?.closest('.markdown-table-toolbar')) return;
      setToolbarVisible(false);
    };
    thead.addEventListener('mouseenter', onEnter);
    thead.addEventListener('mouseleave', onLeave);
    return () => {
      thead.removeEventListener('mouseenter', onEnter);
      thead.removeEventListener('mouseleave', onLeave);
    };
  }, [children]);

  return (
    <div className="markdown-table-root">
      <div className="markdown-table-frame">
        <div className="markdown-table-scroll scrollbar-thin">
          <table className="markdown-table" ref={tableRef}>
            {children}
          </table>
          <div className={`markdown-table-toolbar${toolbarVisible ? ' is-visible' : ''}`}>
            <button
              type="button"
              title="复制 Markdown"
              aria-label="复制表格为 Markdown"
              onClick={() => {
                void handleCopyMarkdown();
              }}
            >
              <CopyIcon size={14} />
            </button>
            <button
              type="button"
              title="下载 CSV"
              aria-label="下载表格为 CSV"
              onClick={handleDownloadCsv}
            >
              <DownloadIcon size={14} />
            </button>
            <button
              type="button"
              title="全屏预览"
              aria-label="打开表格全屏预览"
              onClick={() => setPreviewOpen(true)}
            >
              <Maximize2Icon size={14} />
            </button>
          </div>
        </div>
      </div>
      {previewOpen ? (
        <div
          className="markdown-table-preview-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="表格预览"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPreviewOpen(false);
          }}
        >
          <div className="markdown-table-preview-panel">
            <button
              type="button"
              className="markdown-table-preview-close"
              aria-label="关闭预览"
              onClick={() => setPreviewOpen(false)}
            >
              <XIcon size={14} />
            </button>
            <div className="markdown-table-preview-head">
              <div className="markdown-table-preview-title">表格预览</div>
              <div className="markdown-table-preview-description">
                滚动查看完整表格，表头固定在顶部。
              </div>
            </div>
            <div className="markdown-table-preview-scroll">
              <table className="markdown-table markdown-table-preview">{children}</table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}