// useFileAttachments.ts - Hook for managing file attachments in message input

import { useState, useCallback, useRef } from 'react';
import { compressImage } from './useImageCompression';

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
}

export interface ParsedDocument {
  filename: string;
  charCount: number;
  text: string;
  extractMethod?: 'text' | 'vision' | 'hybrid';
  imageChunks?: Array<{ base64: string; mediaType: string }>;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB target for images after compression
const DOCUMENT_EXTS = new Set(['.docx', '.doc', '.pdf', '.pptx', '.txt', '.md']);

function isDocumentFile(filename: string): boolean {
  const ext = '.' + filename.split('.').pop()?.toLowerCase();
  return DOCUMENT_EXTS.has(ext);
}

function imageChunkToFileAttachment(base64: string, mediaType: string): FileAttachment {
  return {
    id: crypto.randomUUID(),
    name: 'page.png',
    type: mediaType,
    url: `data:${mediaType};base64,${base64}`,
    size: 0,
  };
}

/**
 * Hook for managing file attachments in the message input.
 * Handles file selection, removal, and conversion to FileAttachment format.
 * Automatically compresses images to reduce size.
 */
export function useFileAttachments() {
  const [attachedFiles, setAttachedFiles] = useState<FileAttachment[]>([]);
  const [parsedDocuments, setParsedDocuments] = useState<ParsedDocument[]>([]);
  const [parseErrors, setParseErrors] = useState<Map<string, string>>(new Map());
  const parsingRef = useRef(false);

  /**
   * Convert a File object to a FileAttachment with data URL.
   * Automatically compresses images if they exceed the size limit.
   */
  const convertToFileAttachment = useCallback(async (file: File): Promise<FileAttachment | null> => {
    let processedFile = file;

    // Compress images that are too large
    if (file.type.startsWith('image/') && file.size > MAX_IMAGE_SIZE) {
      try {
        processedFile = await compressImage(file, {
          maxWidth: 2048,
          maxHeight: 2048,
          quality: 0.85,
          maxSizeMB: 5,
        });
      } catch (error) {
        console.warn('Image compression failed, using original:', error);
        processedFile = file;
      }
    }

    // Check file size limit
    if (processedFile.size > MAX_FILE_SIZE) {
      console.warn(`File ${processedFile.name} exceeds size limit of 10MB`);
      return null;
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const attachment: FileAttachment = {
          id: crypto.randomUUID(),
          name: processedFile.name,
          type: processedFile.type,
          url: reader.result as string,
          size: processedFile.size,
        };
        resolve(attachment);
      };
      reader.onerror = () => {
        console.error(`Failed to read file: ${processedFile.name}`);
        resolve(null);
      };
      reader.readAsDataURL(processedFile);
    });
  }, []);

  /**
   * Add a file to the attachments list.
   */
  const addFile = useCallback(async (file: File) => {
    const attachment = await convertToFileAttachment(file);
    if (attachment) {
      setAttachedFiles((prev) => [...prev, attachment]);
    }

    if (isDocumentFile(file.name) && !parsingRef.current) {
      parsingRef.current = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filePath = (file as any).path;
        if (filePath && window.electronAPI?.parser) {
          const result = await window.electronAPI.parser.parse(filePath);
          if (result) {
            const textChunks = result.chunks
              .filter((c): c is { type: 'text'; index: number; text: string } => c.type === 'text')
              .map((c) => c.text);
            const text = textChunks.join('\n\n');

            const imageChunks = result.chunks
              .filter((c): c is { type: 'image'; index: number; base64: string; mediaType: string } => c.type === 'image')
              .map((c) => ({ base64: c.base64, mediaType: c.mediaType }));

            const doc: ParsedDocument = {
              filename: result.filename,
              charCount: result.charCount,
              text,
              extractMethod: result.extractMethod,
            };

            if (imageChunks.length > 0) {
              doc.imageChunks = imageChunks;

              const syntheticAttachments = imageChunks.map((ic) =>
                imageChunkToFileAttachment(ic.base64, ic.mediaType),
              );
              setAttachedFiles((prev) => [...prev, ...syntheticAttachments]);
            }

            setParsedDocuments((prev) => [...prev, doc]);
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        setParseErrors((prev) => {
          const next = new Map(prev);
          next.set(file.name, errMsg);
          return next;
        });
      } finally {
        parsingRef.current = false;
      }
    }
  }, [convertToFileAttachment]);

  /**
   * Remove a file from the attachments list by ID.
   */
  const removeFile = useCallback((id: string) => {
    setAttachedFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.url.startsWith('blob:')) {
        URL.revokeObjectURL(file.url);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setAttachedFiles((prev) => {
      prev.forEach((file) => {
        if (file.url.startsWith('blob:')) {
          URL.revokeObjectURL(file.url);
        }
      });
      return [];
    });
    setParsedDocuments([]);
    setParseErrors(new Map());
  }, []);

  /**
   * Handle file input change event.
   */
  const handleFileInput = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    if (!input.files) return;

    const files = Array.from(input.files);
    for (const file of files) {
      await addFile(file);
    }

    // Reset input so the same file can be selected again
    input.value = '';
  }, [addFile]);

  return {
    attachedFiles,
    parsedDocuments,
    parseErrors,
    addFile,
    removeFile,
    clearFiles,
    handleFileInput,
    convertToFileAttachment,
    MAX_FILE_SIZE,
  };
}
