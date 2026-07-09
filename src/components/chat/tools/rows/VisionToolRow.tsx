// VisionToolRow — renders the vision_analyze tool result.
//
// The chrome shows "vision_analyze" (or its alias) as the summary. Below
// the chrome sits a small preview card of the analyzed image plus a
// 3-line snippet of the analysis text. Click the preview to open
// ToolImagePreviewModal: image on the left, the question (if any) and
// full analysis text on the right.
//
// The tool result is plain text produced by VisionTool.ts:
//   "Image analyzed: <path>\nFormat: <mime> | Size: <kb> KB\n[Question: <q>]\n\n<analysis>"
// `parseVisionToolResult` extracts the header / question / analysis for
// the modal; older sessions without `imageDataUrl` in metadata fall back
// to the chrome-only render.

'use client';

import React, { useState } from 'react';
import { EyeIcon } from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { ToolStatusBadge } from '../statusBadge';
import { getStatus } from '../registry';
import { ToolImagePreviewModal } from '../ToolImagePreviewModal';
import type { ToolAction } from '../types';

interface VisionToolRowProps {
  tool: ToolAction;
}

interface VisionToolResult {
  /** "Image analyzed: <path>" line minus the prefix. */
  imageLabel: string;
  /** Format / size line, e.g. "Format: image/png | Size: 12.3 KB". */
  formatLine: string;
  /** Optional "Question: ..." line. */
  question?: string;
  /** The analysis text body, after the leading metadata block. */
  analysis: string;
}

function parseVisionToolResult(result: string | undefined): VisionToolResult | null {
  if (!result) return null;
  const lines = result.split('\n');
  let imageLabel = '';
  let formatLine = '';
  let question: string | undefined;
  // Find the index of the first blank line — everything after is body.
  let bodyStartIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Image analyzed:')) {
      imageLabel = line.slice('Image analyzed:'.length).trim();
    } else if (line.startsWith('Format:')) {
      formatLine = line.trim();
    } else if (line.startsWith('Question:')) {
      question = line.slice('Question:'.length).trim();
    } else if (line.trim() === '') {
      bodyStartIndex = i + 1;
      break;
    }
  }
  const analysis = lines.slice(bodyStartIndex).join('\n').trim();
  if (!imageLabel && !analysis) return null;
  return { imageLabel, formatLine, question, analysis };
}

export function VisionToolRow({ tool }: VisionToolRowProps) {
  const status = getStatus(tool);
  const [previewOpen, setPreviewOpen] = useState(false);

  const metadata = (tool.metadata ?? {}) as {
    imageDataUrl?: string | null;
    imagePath?: string;
    mimeType?: string | null;
    imageSizeBytes?: number;
  };
  const hasPreview = typeof metadata.imageDataUrl === 'string' && metadata.imageDataUrl.length > 0;

  const parsed = parseVisionToolResult(tool.result);
  const analysisSnippet = parsed?.analysis.slice(0, 240) ?? '';

  // Status-aware verb label — mirrors SkillToolRow / ModuleToolRow so
  // the chrome reads "正在分析图像…" → "已调用视觉能力" / "视觉分析失败".
  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.vision'
    : status === 'error' ? 'streaming.toolAction.error.vision'
    : 'streaming.toolAction.done.vision';

  return (
    <div>
      <ActionRowChrome
        status={status}
        verbKey={verbKey}
        canExpand={false}
        expanded={false}
        hovered={false}
        durationMs={tool.durationMs}
        buttonClassName="cursor-default"
      >
        {parsed?.imageLabel || tool.name}
      </ActionRowChrome>

      {hasPreview ? (
        <div className="mx-1 my-1 flex flex-col items-start gap-0">
          <div className="flex flex-wrap items-start gap-2">
            <button
              type="button"
              className="tool-image-preview"
              onClick={() => setPreviewOpen(true)}
              aria-label={`Open analyzed image preview${parsed?.question ? ` for: ${parsed.question}` : ''}`}
            >
              <img
                src={metadata.imageDataUrl ?? ''}
                alt={parsed?.imageLabel || 'Analyzed image'}
                className="tool-image-preview-img"
                loading="lazy"
              />
              <div className="tool-image-preview-shade" />
              <div className="tool-image-preview-meta">
                <span className="tool-image-preview-title">
                  {parsed?.imageLabel || 'Analyzed image'}
                </span>
                <span className="tool-image-preview-label">
                  <EyeIcon size={10} />
                  <span className="tool-image-preview-label-text">VISION</span>
                </span>
              </div>
            </button>
            <ToolStatusBadge status={status} />
          </div>
          {analysisSnippet && (
            <p className="tool-image-preview-snippet" title={parsed?.analysis}>
              {analysisSnippet}
            </p>
          )}
        </div>
      ) : null}

      <ToolImagePreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        src={metadata.imageDataUrl ?? ''}
        title={parsed?.imageLabel || 'Analyzed image'}
        subtitle={
          metadata.mimeType
            ? `${metadata.mimeType}${typeof metadata.imageSizeBytes === 'number' ? ` · ${(metadata.imageSizeBytes / 1024).toFixed(1)} KB` : ''}`
            : undefined
        }
        question={parsed?.question}
        body={parsed?.analysis || '(no analysis text returned)'}
      />
    </div>
  );
}