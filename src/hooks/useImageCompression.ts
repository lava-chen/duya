// useImageCompression.ts - Hook for compressing images before upload

import { useCallback } from 'react';

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  maxSizeMB?: number;
}

const DEFAULT_OPTIONS: CompressionOptions = {
  maxWidth: 2048,
  maxHeight: 2048,
  quality: 0.85,
  maxSizeMB: 5,
};

/**
 * Compress an image file to reduce size while maintaining quality.
 * Uses canvas-based resizing and JPEG compression.
 */
export async function compressImage(
  file: File,
  options: CompressionOptions = {}
): Promise<File> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // If file is already small enough and is a JPEG/PNG, return as-is
  const maxSizeBytes = (opts.maxSizeMB || 5) * 1024 * 1024;
  if (file.size <= maxSizeBytes && (file.type === 'image/jpeg' || file.type === 'image/png')) {
    return file;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Calculate new dimensions maintaining aspect ratio
      let { width, height } = img;
      const maxWidth = opts.maxWidth || 2048;
      const maxHeight = opts.maxHeight || 2048;

      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      // Create canvas and draw resized image
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Use better quality rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      // Convert to blob with compression
      const quality = opts.quality || 0.85;
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Failed to compress image'));
            return;
          }

          // Create new file from blob
          const compressedFile = new File(
            [blob],
            file.name.replace(/\.[^.]+$/, '.jpg'),
            { type: 'image/jpeg', lastModified: Date.now() }
          );

          resolve(compressedFile);
        },
        'image/jpeg',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for compression'));
    };

    img.src = url;
  });
}

/**
 * Hook for image compression functionality.
 */
export function useImageCompression() {
  const compress = useCallback(async (
    file: File,
    options?: CompressionOptions
  ): Promise<File> => {
    // Only compress image files
    if (!file.type.startsWith('image/')) {
      return file;
    }

    try {
      const compressed = await compressImage(file, options);
      return compressed;
    } catch (error) {
      console.warn('Image compression failed, using original file:', error);
      return file;
    }
  }, []);

  return { compress };
}
