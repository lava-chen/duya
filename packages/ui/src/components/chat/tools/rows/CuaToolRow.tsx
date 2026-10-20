/**
 * CuaToolRow — renders a `computer_cua` tool call as a toolrow with the
 * target app's icon (plan 575 §CUA toolrow).
 *
 * App info (name, bundleId, iconDataUrl) is read from tool.metadata when
 * the agent populates it from the CUA result display.
 *
 * Icon resolution order:
 *  1. iconDataUrl in metadata  — fastest, agent already has it
 *  2. bundleId in metadata     — fetch via IPC (duya.cua.getApplicationIcon)
 *  3. fallback                — MonitorIcon
 *
 * Windows: bundleId is the exe path; nativeImage.createFromPath reads
 * the embedded icon directly.  macOS bundle identifiers fall back to
 * MonitorIcon on Windows.
 */

'use client';

import React, { useEffect, useState } from 'react';
import { MonitorIcon } from '@/components/icons';
import type { ToolAction } from '../types';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';

interface CuaToolRowProps {
  tool: ToolAction;
}

const CUA_ACTION_LABELS: Record<string, string> = {
  list_apps:        'list apps',
  list_windows:     'list windows',
  get_app_state:    'get app state',
  left_click:       'click',
  left_click_drag:  'click drag',
  right_click:      'right click',
  right_click_drag: 'right click drag',
  double_click:     'double click',
  triple_click:     'triple click',
  scroll:           'scroll',
  type:             'type',
  set_value:        'set value',
  select_text:      'select text',
  key:              'key',
  perform_action:   'perform action',
  paste:            'paste',
  screenshot:        'screenshot',
  capture:           'capture',
  stop_computer_control:  'stop',
  request_access:        'request access',
};

/** Maps computer_cua `tool` sub-action field to a short label. */
function getCuaActionLabel(toolName: string, input: Record<string, unknown> | undefined): string {
  const action = (input?.tool as string | undefined) ?? '';
  return CUA_ACTION_LABELS[action] ?? toolName;
}

/** Extract cuaApp metadata injected by the agent from result.display.targetApp. */
interface CuaAppMeta {
  appName?: string;
  bundleId?: string;
  iconDataUrl?: string;
}

function getCuaAppMeta(tool: ToolAction): CuaAppMeta {
  return (tool.metadata as Record<string, unknown> | undefined)?.cuaApp as CuaAppMeta | undefined ?? {};
}

export function CuaToolRow({ tool }: CuaToolRowProps) {
  const [hovered] = useState(false);
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  const [iconError, setIconError] = useState(false);
  const status = getStatus(tool);

  const input = tool.input as Record<string, unknown> | undefined;
  const actionLabel = getCuaActionLabel(tool.name, input);
  const appMeta = getCuaAppMeta(tool);
  const appName = appMeta.appName ?? 'Computer';

  // Build summary text
  let summary = actionLabel;
  if (input) {
    if (input.label !== undefined) {
      summary = typeof input.label === 'string' ? `${actionLabel} ${input.label}` : summary;
    } else if (input.element !== undefined) {
      summary = typeof input.element === 'string' ? `${actionLabel} ${input.element}` : summary;
    } else if (input.text !== undefined) {
      const text = typeof input.text === 'string' ? input.text : String(input.text);
      summary = text.length > 40 ? `${actionLabel} "${text.slice(0, 40)}…"` : `${actionLabel} "${text}"`;
    } else if (input.keys !== undefined) {
      const keys = typeof input.keys === 'string' ? input.keys : JSON.stringify(input.keys);
      summary = `${actionLabel} ${keys}`;
    } else if (input.amount !== undefined || input.direction !== undefined) {
      const dir = input.direction ? String(input.direction) : '';
      const amt = input.amount !== undefined ? String(input.amount) : '';
      summary = `${actionLabel} ${dir} ${amt}`.trim();
    }
  }

  // Fetch app icon via IPC when bundleId is present but iconDataUrl is missing
  useEffect(() => {
    if (appMeta.bundleId && !appMeta.iconDataUrl) {
      const win = window as Window & { duya?: { cua?: { getApplicationIcon: (id: string) => Promise<string | null> } } };
      if (win.duya?.cua?.getApplicationIcon) {
        win.duya.cua.getApplicationIcon(appMeta.bundleId).then((url) => {
          if (url) setIconDataUrl(url);
        });
      }
    }
  }, [appMeta.bundleId, appMeta.iconDataUrl]);

  // Resolve final icon source: metadata > IPC fetch > MonitorIcon
  const resolvedIconDataUrl = appMeta.iconDataUrl || iconDataUrl;
  const showAppIcon = resolvedIconDataUrl && !iconError;
  const leadingIcon = showAppIcon ? (
    <img
      src={resolvedIconDataUrl!}
      alt={appName}
      className="w-4 h-4 rounded-sm object-contain"
      onError={() => setIconError(true)}
    />
  ) : (
    <MonitorIcon size={14} className="text-muted-foreground/60" />
  );

  return (
    <ActionRowChrome
      status={status}
      verbText={appName}
      icon={leadingIcon}
      canExpand={false}
      expanded={false}
      hovered={hovered}
      durationMs={tool.durationMs}
    >
      {summary}
    </ActionRowChrome>
  );
}
