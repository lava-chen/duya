// useFileAttachments.ts - Hook for managing file attachments in message input

import { useState, useCallback } from 'react';
import { compressImage } from './useImageCompression';

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB target for images after compression

/**
 * Hook for managing file attachments in the message input.
 * Handles file selection, removal, and conversion to FileAttachment format.
 * Automatically compresses images to reduce size.
 */
export function useFileAttachments() {
  const [attachedFiles, setAttachedFiles] = useState<FileAttachment[]>([]);

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
  }, [convertToFileAttachment]);

  /**
   * Remove a file from the attachments list by ID.
   */
  const removeFile = useCallback((id: string) => {
    setAttachedFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      // Revoke object URL to free memory if it's a blob URL
      if (file?.url.startsWith('blob:')) {
        URL.revokeObjectURL(file.url);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  /**
   * Clear all attached files.
   */
  const clearFiles = useCallback(() => {
    setAttachedFiles((prev) => {
      // Revoke all blob URLs to free memory
      prev.forEach((file) => {
        if (file.url.startsWith('blob:')) {
          URL.revokeObjectURL(file.url);
        }
      });
      return [];
    });
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
    addFile,
    removeFile,
    clearFiles,
    handleFileInput,
    convertToFileAttachment,
    MAX_FILE_SIZE,
  };
}
