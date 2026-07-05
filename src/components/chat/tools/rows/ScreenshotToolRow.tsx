// ScreenshotToolRow — renders the browser tool's screenshot operation.
//
// The chrome shows the page title / URL, the status badge, and a small
// square preview card with the captured image. Click the preview to
// open the full-size image in ToolImagePreviewModal. The right pane of
// the modal is hidden (no extra text to show alongside the image).
//
// When the screenshot is missing (fallback mode, error, no metadata
// attached) the row falls back to the chrome-only render so the user
// still sees "Screenshot captured" / "Failed".

'use client';

import React, { useState } from 'react';
import { ImageIcon } from '@/components/icons';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { ToolStatusBadge } from '../statusBadge';
import { getStatus } from '../registry';
import { ToolImagePreviewModal } from '../ToolImagePreviewModal';
import type { ToolAction } from '../types';

interface ScreenshotToolRowProps {
  tool: ToolAction;
}

interface ScreenshotInput {
  fullPage?: boolean;
  selector?: string;
}

function parseScreenshotInput(input: unknown): ScreenshotInput {
  if (!input || typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  return {
    fullPage: obj.fullPage === true,
    selector: typeof obj.selector === 'string' ? obj.selector : undefined,
  };
}

function buildSubtitle(input: ScreenshotInput): string | undefined {
  if (input.selector) return `Selector: ${input.selector}`;
  if (input.fullPage) return 'Full page';
  return undefined;
}

export function ScreenshotToolRow({ tool }: ScreenshotToolRowProps) {
  const status = getStatus(tool);
  const [previewOpen, setPreviewOpen] = useState(false);

  const metadata = (tool.metadata ?? {}) as {
    screenshot?: string;
    screenshotBytes?: number;
    screenshotWidth?: number;
    screenshotHeight?: number;
  };
  const hasPreview = typeof metadata.screenshot === 'string';

  const screenshotInput = parseScreenshotInput(tool.input);
  const subtitle = buildSubtitle(screenshotInput);

  const fileNameFromInput = (() => {
    const t = tool.name;
    if (subtitle) return `${t} · ${subtitle}`;
    return t;
  })();

  return (
    <div>
      <ActionRowChrome
        status={status}
        canExpand={false}
        expanded={false}
        hovered={false}
        durationMs={tool.durationMs}
        buttonClassName="cursor-default"
      >
        {fileNameFromInput}
      </ActionRowChrome>

      {hasPreview ? (
        <div className="mx-1 my-1 flex flex-wrap items-start gap-2">
          <button
            type="button"
            className="tool-image-preview"
            onClick={() => setPreviewOpen(true)}
            aria-label={`Open screenshot preview${subtitle ? ` (${subtitle})` : ''}`}
          >
            <img
              src={metadata.screenshot}
              alt={subtitle || 'Browser screenshot'}
              className="tool-image-preview-img"
              loading="lazy"
            />
            <div className="tool-image-preview-shade" />
            <div className="tool-image-preview-meta">
              <span className="tool-image-preview-title">
                {subtitle || 'Browser screenshot'}
              </span>
              <span className="tool-image-preview-label">
                <ImageIcon size={10} />
                <span className="tool-image-preview-label-text">SCREENSHOT</span>
              </span>
            </div>
          </button>
          <ToolStatusBadge status={status} />
        </div>
      ) : null}

      <ToolImagePreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        src={metadata.screenshot ?? ''}
        title={subtitle ? `Browser screenshot · ${subtitle}` : 'Browser screenshot'}
        subtitle={typeof metadata.screenshotWidth === 'number' && typeof metadata.screenshotHeight === 'number'
          ? `${metadata.screenshotWidth}×${metadata.screenshotHeight}${typeof metadata.screenshotBytes === 'number' ? ` · ${(metadata.screenshotBytes / 1024).toFixed(1)} KB` : ''}`
          : undefined}
        body=""
        hideTextPane
      />
    </div>
  );
}