/**
 * BotMessageAction — Hover action anchor for bot message bubbles.
 *
 * Inspired by grok-bot's TranscriptCardActionAnchor:
 *   - Hover / focus / menu-open → shows action toolbar
 *   - Reply button (sets reply target)
 *   - Copy button (copies text to clipboard)
 *   - More menu (dots) → context menu with Start a thread / Copy
 *
 * The wrapped bubble must accept ref-forwarding for the anchor to work.
 */

import React, { useState, useRef, useEffect } from 'react';
import { CopyIcon, CheckIcon, DotsThreeIcon, ChatCircleIcon } from '@/components/icons';

interface BotMessageActionProps {
  /** The bubble content to wrap */
  children: React.ReactNode;
  /** Text content to copy (optional — if not provided, copy button is hidden) */
  textToCopy?: string;
  /** Called when user clicks Reply */
  onReply?: () => void;
  /** Is the transcript read-only? (hides action bar) */
  readOnly?: boolean;
  className?: string;
}

export function BotMessageAction({
  children,
  textToCopy,
  onReply,
  readOnly = false,
  className = '',
}: BotMessageActionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuPosition, setMenuPosition] = useState<'above' | 'below'>('below');
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node) &&
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  // Close on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [menuOpen]);

  const handleCopy = async () => {
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setMenuOpen(false);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  const toggleMenu = () => {
    if (!menuOpen) {
      // Position menu above or below based on viewport
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const spaceBelow = window.innerHeight - rect.bottom;
        setMenuPosition(spaceBelow < 180 ? 'above' : 'below');
      }
    }
    setMenuOpen((v) => !v);
  };

  if (readOnly) {
    return (
      <div ref={anchorRef} className={`bot-message-action ${className}`}>
        {children}
      </div>
    );
  }

  return (
    <div
      ref={anchorRef}
      className={`bot-message-action ${menuOpen ? 'bot-message-action--menu-open' : ''} ${className}`}
    >
      {children}

      {/* Hover action toolbar */}
      <div className="bot-message-hover-actions" role="toolbar" aria-label="Message actions">
        {onReply && (
          <button
            type="button"
            className="bot-message-hover-actions__btn"
            onClick={onReply}
            title="Reply"
            aria-label="Reply"
          >
            <ChatCircleIcon size={13} />
          </button>
        )}

        {textToCopy && (
          <button
            type="button"
            className="bot-message-hover-actions__btn"
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy'}
            aria-label={copied ? 'Copied!' : 'Copy'}
          >
            {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          </button>
        )}

        <button
          type="button"
          className="bot-message-hover-actions__btn"
          onClick={toggleMenu}
          title="More"
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <DotsThreeIcon size={13} />
        </button>
      </div>

      {/* Context menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          className={`bot-message-context-menu ${menuPosition === 'above' ? 'bot-message-context-menu--above' : ''}`}
          role="menu"
        >
          {onReply && (
            <button
              type="button"
              className="bot-message-context-menu__item"
              onClick={() => { onReply(); setMenuOpen(false); }}
              role="menuitem"
            >
              <ChatCircleIcon size={14} />
              <span>Reply</span>
            </button>
          )}
          {textToCopy && (
            <button
              type="button"
              className="bot-message-context-menu__item"
              onClick={handleCopy}
              role="menuitem"
            >
              {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
              <span>{copied ? 'Copied!' : 'Copy text'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
