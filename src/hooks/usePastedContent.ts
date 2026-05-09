// usePastedContent.ts - Hook for managing pasted text content as attachments

import { useState, useCallback } from 'react';
import { wrapPastedContent } from '@/lib/message-content-parser';

export interface PastedContent {
  id: string;
  content: string;
  preview: string;
  timestamp: number;
}

const MAX_PASTE_LENGTH = 500;
const PREVIEW_LENGTH = 120;

/**
 * Hook for managing pasted text content in the message input.
 * Handles paste events, stores long text as attachments, and provides removal functionality.
 */
export function usePastedContent() {
  const [pastedContents, setPastedContents] = useState<PastedContent[]>([]);

  /**
   * Check if text should be treated as pasted content (long text)
   */
  const shouldTreatAsPastedContent = useCallback((text: string): boolean => {
    return text.length > MAX_PASTE_LENGTH;
  }, []);

  /**
   * Create a preview of the content (first N characters)
   */
  const createPreview = useCallback((content: string): string => {
    const trimmed = content.trim();
    if (trimmed.length <= PREVIEW_LENGTH) {
      return trimmed;
    }
    return trimmed.substring(0, PREVIEW_LENGTH) + '...';
  }, []);

  /**
   * Add pasted content as an attachment
   */
  const addPastedContent = useCallback((content: string): PastedContent | null => {
    if (!content.trim()) return null;

    const pastedContent: PastedContent = {
      id: crypto.randomUUID(),
      content: content.trim(),
      preview: createPreview(content),
      timestamp: Date.now(),
    };

    setPastedContents((prev) => [...prev, pastedContent]);
    return pastedContent;
  }, [createPreview]);

  /**
   * Remove a pasted content by ID
   */
  const removePastedContent = useCallback((id: string) => {
    setPastedContents((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /**
   * Clear all pasted contents
   */
  const clearPastedContents = useCallback(() => {
    setPastedContents([]);
  }, []);

  /**
   * Handle paste event from textarea
   * Returns the pasted content if it was treated as an attachment, null otherwise
   */
  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>): PastedContent | null => {
    const pastedText = event.clipboardData.getData('text');

    // Only treat as pasted content if it's long enough
    if (shouldTreatAsPastedContent(pastedText)) {
      event.preventDefault();
      return addPastedContent(pastedText);
    }

    return null;
  }, [shouldTreatAsPastedContent, addPastedContent]);

  /**
   * Get all content as a combined string with markers (for storage and display)
   */
  const getCombinedContentWithMarkers = useCallback((inputText: string): string => {
    const parts: string[] = [];

    // Add all pasted contents with markers
    pastedContents.forEach((item) => {
      parts.push(wrapPastedContent(item.id, item.preview, item.content));
    });

    // Add input text if not empty
    const trimmedInput = inputText.trim();
    if (trimmedInput) {
      parts.push(trimmedInput);
    }

    return parts.join('\n\n');
  }, [pastedContents]);

  /**
   * Get all content as a combined string (for sending to API - plain text without markers)
   */
  const getCombinedContent = useCallback((inputText: string): string => {
    const parts: string[] = [];

    // Add all pasted contents
    pastedContents.forEach((item) => {
      parts.push(item.content);
    });

    // Add input text if not empty
    const trimmedInput = inputText.trim();
    if (trimmedInput) {
      parts.push(trimmedInput);
    }

    return parts.join('\n\n');
  }, [pastedContents]);

  /**
   * Check if there are any pasted contents
   */
  const hasPastedContents = pastedContents.length > 0;

  /**
   * Get total character count of all pasted content
   */
  const getTotalCharCount = useCallback((): number => {
    return pastedContents.reduce((total, item) => total + item.content.length, 0);
  }, [pastedContents]);

  return {
    pastedContents,
    addPastedContent,
    removePastedContent,
    clearPastedContents,
    handlePaste,
    getCombinedContent,
    getCombinedContentWithMarkers,
    hasPastedContents,
    getTotalCharCount,
    MAX_PASTE_LENGTH,
  };
}
