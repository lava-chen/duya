// useFileAttachments.ts - Hook for managing file attachments in message input

import { useState, useCallback, useRef } from 'react';
import { compressImage } from './useImageCompression';

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  /** URL can be: data URL (images), absolute file path, or empty for placeholder */
  url: string;
  size: number;
  /** Absolute file path for document files (pdf, docx, etc.) */
  path?: string;
  /** Parsed text content for document files */
  text?: string;
  /** Extraction method for parsed documents */
  extractMethod?: 'text' | 'vision' | 'hybrid';
  /** Image chunks from OCR/vision extraction */
  imageChunks?: Array<{ base64: string; mediaType: string }>;
  /** Thumbnail preview for document files (base64 data URL) */
  thumbnail?: string;
  /** Base64 data URL for image display (used when url is a file path) */
  displayUrl?: string;
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
  const [parseErrors, setParseErrors] = useState<Map<string, string>>(new Map());
  const [isParsing, setIsParsing] = useState(false);
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
   * Resolve a real filesystem path for a File. Electron < 32 sets `file.path`,
   * but newer versions require `webUtils.getPathForFile`. This helper covers both.
   */
  const resolveFilePath = useCallback((file: File): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyPath = (file as any).path;
    if (legacyPath) return legacyPath as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webUtils = (window as any).electronWebUtils;
    if (webUtils?.getPathForFile) {
      try {
        return webUtils.getPathForFile(file) as string;
      } catch {
        return '';
      }
    }
    return '';
  }, []);

  /**
   * Add a file to the attachments list.
   */
  const addFile = useCallback(async (file: File) => {
    if (isDocumentFile(file.name)) {
      // Document files (pdf, docx, etc.) — add a placeholder, then update in place
      // after parsing completes. All parsed data goes into the attachment itself.
      const filePath = resolveFilePath(file);
      const placeholderId = crypto.randomUUID();
      setAttachedFiles((prev) => [...prev, {
        id: placeholderId,
        name: file.name,
        type: file.type,
        url: filePath,
        path: filePath,
        size: file.size,
      }]);

      if (!parsingRef.current) {
        parsingRef.current = true;
        setIsParsing(true);
        try {
          if (!filePath) {
            setParseErrors((prev) => {
              const next = new Map(prev);
              next.set(file.name, '无法获取文件路径，请通过文件对话框选择文件');
              return next;
            });
            return;
          }
          if (!window.electronAPI?.parser) {
            setParseErrors((prev) => {
              const next = new Map(prev);
              next.set(file.name, '文档解析服务未初始化，请重启应用');
              return next;
            });
            return;
          }
          const result = await window.electronAPI.parser.parse(filePath);
          if (result) {
            const textChunks = result.chunks
              .filter((c): c is { type: 'text'; index: number; text: string } => c.type === 'text')
              .map((c) => c.text);
            const text = textChunks.join('\n\n');

            const imageChunks = result.chunks
              .filter((c): c is { type: 'image'; index: number; base64: string; mediaType: string } => c.type === 'image')
              .map((c) => ({ base64: c.base64, mediaType: c.mediaType }));

            // Build thumbnail data URL from parser result
            const thumbnail = result.thumbnail
              ? `data:${result.thumbnail.mediaType};base64,${result.thumbnail.base64}`
              : undefined;

            // Update placeholder with parsed data
            setAttachedFiles((prev) => prev.map((f) =>
              f.id === placeholderId ? {
                ...f,
                url: filePath,
                path: filePath,
                text,
                extractMethod: result.extractMethod,
                imageChunks: imageChunks.length > 0 ? imageChunks : undefined,
                thumbnail,
              } : f
            ));
            console.log('[useFileAttachments] attachment updated:', {
              id: placeholderId,
              name: result.filename,
              hasText: !!text,
              textLength: text.length,
              imageChunksCount: imageChunks.length,
              hasThumbnail: !!thumbnail,
            });
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
          setIsParsing(false);
        }
      }
    } else {
      // Image files — generate thumbnail for display, store path for vision tool
      const filePath = resolveFilePath(file);
      if (filePath) {
        // Generate thumbnail for display (browsers can't show file:// URLs)
        let thumbnailUrl = '';
        try {
          const thumbnail = await compressImage(file, {
            maxWidth: 400,
            maxHeight: 300,
            quality: 0.7,
            maxSizeMB: 0.5,
          });
          // Convert to base64 data URL for display
          thumbnailUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => resolve('');
            reader.readAsDataURL(thumbnail);
          });
        } catch (err) {
          console.warn('[useFileAttachments] Thumbnail generation failed:', err);
        }

        setAttachedFiles((prev) => [...prev, {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          url: filePath,       // Original file path for vision_analyze tool
          path: filePath,      // Also stored in path field
          size: file.size,
          displayUrl: thumbnailUrl, // Base64 thumbnail for display
        }]);
      } else {
        // Fallback: if no path available (shouldn't happen in Electron), compress and store as data URL
        console.warn('[useFileAttachments] No file path available for image, falling back to data URL');
        const attachment = await convertToFileAttachment(file);
        if (attachment) {
          setAttachedFiles((prev) => [...prev, attachment]);
        }
      }
    }
  }, [convertToFileAttachment, resolveFilePath]);

  /**
   * Remove a file from the attachments list by ID.
   */
  const removeFile = useCallback((id: string) => {
    const file = attachedFiles.find((f) => f.id === id);
    setAttachedFiles((prev) => {
      if (file?.url.startsWith('blob:')) {
        URL.revokeObjectURL(file.url);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, [attachedFiles]);

  const clearFiles = useCallback(() => {
    setAttachedFiles((prev) => {
      prev.forEach((file) => {
        if (file.url.startsWith('blob:')) {
          URL.revokeObjectURL(file.url);
        }
      });
      return [];
    });
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
    parseErrors,
    isParsing,
    addFile,
    removeFile,
    clearFiles,
    handleFileInput,
    convertToFileAttachment,
    MAX_FILE_SIZE,
  };
}
