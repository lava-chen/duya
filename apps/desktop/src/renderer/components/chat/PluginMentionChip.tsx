// PluginMentionChip.tsx - the single owner of the plugin @-mention chip look,
// shared by the two surfaces that draw it:
//
//   - the composer: RichTextInput builds the chip imperatively into a
//     contentEditable node and imports the style constants + glyph paths here.
//   - the transcript: <PluginMentionText> renders the same chip in React for a
//     sent user message bubble.
//
// Keeping the visual in one module is deliberate — a chip that looks different
// before and after sending reads as a bug.

import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { CODE_FONT_FAMILY } from '@/lib/rich-text-canonical';
import { splitPluginMentionText } from '@/lib/plugin-mention-display';
import type { PluginMentionTarget } from '@/lib/message-input-logic';
import { usePluginMentionTargets } from '@/stores/plugin-mention-store';

/** Name colour: the composer's skill/mention blue. */
export const MENTION_BLUE = '#3b82f6';
export const MENTION_CHIP_BACKGROUND = 'rgba(59, 130, 246, 0.12)';

/** Chip container. Values are strings so imperative `Object.assign` on a
 *  DOM CSSStyleDeclaration behaves exactly like React's style prop. */
export const MENTION_CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
  padding: '0 5px',
  margin: '0 1px',
  borderRadius: '6px',
  background: MENTION_CHIP_BACKGROUND,
};

export const MENTION_ICON_STYLE: CSSProperties = {
  width: '14px',
  height: '14px',
  objectFit: 'contain',
  borderRadius: '3px',
  flexShrink: 0,
};

/** Name text: blue, in the same font as fenced code blocks. */
export const MENTION_LABEL_STYLE: CSSProperties = {
  color: MENTION_BLUE,
  fontFamily: CODE_FONT_FAMILY,
  fontSize: '0.9em',
  lineHeight: 1.3,
};

/** Tabler "plug-connected" glyph, used when a plugin has no icon. */
export const PLUG_GLYPH_PATHS: readonly string[] = [
  'M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5',
  'M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5',
  'M3 21l2.5 -2.5',
  'M18.5 5.5l2.5 -2.5',
  'M10 11l-2 2',
  'M13 14l-2 2',
];

export function PlugGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      {PLUG_GLYPH_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export interface PluginMentionChipProps {
  /** Plugin id — mirrored onto `data-plugin-mention` like the composer chip. */
  pluginId?: string;
  /** Display name shown in blue. */
  name: string;
  /** Resolved `duya-file://` icon URL; falls back to the plug glyph. */
  iconUrl?: string;
}

/** The chip itself — icon + blue name, non-interactive. */
export function PluginMentionChip({ pluginId, name, iconUrl }: PluginMentionChipProps) {
  const [iconFailed, setIconFailed] = useState(false);
  const showIcon = Boolean(iconUrl) && !iconFailed;

  return (
    <span style={MENTION_CHIP_STYLE} title={name} data-plugin-mention={pluginId ?? name}>
      {showIcon ? (
        <img
          src={iconUrl}
          alt=""
          width={14}
          height={14}
          style={MENTION_ICON_STYLE}
          onError={() => setIconFailed(true)}
        />
      ) : (
        <PlugGlyph />
      )}
      <span style={MENTION_LABEL_STYLE}>{name}</span>
    </span>
  );
}

export interface PluginMentionTextProps {
  /** Plain message text that may contain `@plugin` tokens or plugin links. */
  text: string;
  /** Override the store targets (tests / callers with their own list). */
  targets?: readonly PluginMentionTarget[];
}

/**
 * Render message text with inline plugin mention chips. Everything that is not
 * a resolved mention is emitted verbatim, so callers keep their own
 * `whitespace-pre-wrap` styling on the wrapping element.
 */
export function PluginMentionText({ text, targets }: PluginMentionTextProps) {
  const storeTargets = usePluginMentionTargets();
  const resolved = targets ?? storeTargets;
  const segments = useMemo(() => splitPluginMentionText(text, resolved), [text, resolved]);

  return (
    <>
      {segments.map((segment, index) => (
        segment.type === 'text'
          ? <React.Fragment key={`t-${index}`}>{segment.value}</React.Fragment>
          : (
            <PluginMentionChip
              key={`m-${index}`}
              pluginId={segment.pluginId}
              name={segment.label}
              iconUrl={segment.iconUrl}
            />
          )
      ))}
    </>
  );
}

export interface PluginMentionLinkChipProps {
  pluginId: string;
  /** Link label, leading `@` already stripped by the caller. */
  label?: string;
}

/**
 * Chip for a `plugin://<id>` markdown link (the form the agent prompt itself
 * emits). The store subscription lives here rather than in MarkdownAnchor so
 * ordinary links never subscribe to the plugin registry.
 */
export function PluginMentionLinkChip({ pluginId, label }: PluginMentionLinkChipProps) {
  const targets = usePluginMentionTargets();
  const target = targets.find((t) => t.pluginId.toLowerCase() === pluginId.toLowerCase());

  return (
    <PluginMentionChip
      pluginId={pluginId}
      name={target?.name || label || `@${pluginId}`}
      iconUrl={target?.iconUrl}
    />
  );
}
