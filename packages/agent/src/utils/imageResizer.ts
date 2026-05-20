/**
 * Image Resizer - Compress and resize images for LLM vision processing
 *
 * Features:
 * - Resize images to max dimensions (2048x2048)
 * - Compress to stay under size limits
 * - Preserve aspect ratio
 */

// @ts-ignore - jimp types issue
import { Jimp } from 'jimp';

// Anthropic API limits
export const MAX_IMAGE_DIMENSION = 2048;
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB base64
export const TARGET_IMAGE_SIZE_BYTES = 3.75 * 1024 * 1024; // Target 3.75MB before base64 encoding

export interface ImageResizeResult {
  buffer: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasResized: boolean;
  sizeReduction: number; // bytes saved
}

/**
 * Get image dimensions from buffer (without fully decoding)
 */
export function getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    // PNG: IHDR chunk starts at byte 8, width at byte 16, height at byte 20 (big-endian)
    if (buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
  }

  // JPEG signature: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    // JPEG: search for SOF marker (FF C0-FF CF except FF C4, FF C8, FF CC)
    for (let i = 2; i < buffer.length - 9; i++) {
      if (buffer[i] === 0xFF && buffer[i + 1] >= 0xC0 && buffer[i + 1] <= 0xCF &&
          buffer[i + 1] !== 0xC4 && buffer[i + 1] !== 0xC8 && buffer[i + 1] !== 0xCC) {
        const height = buffer.readUInt16BE(i + 5);
        const width = buffer.readUInt16BE(i + 7);
        return { width, height };
      }
    }
  }

  // GIF signature: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    if (buffer.length >= 10) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }
  }

  return null;
}

/**
 * Detect media type from buffer magic bytes
 */
export function detectMediaType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }

  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }

  // WebP (RIFF....WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  return null;
}

/**
 * Resize and compress an image buffer to fit within size limits
 */
export async function resizeImageBuffer(
  buffer: Buffer,
  targetSize: number = TARGET_IMAGE_SIZE_BYTES,
  maxDimension: number = MAX_IMAGE_DIMENSION
): Promise<ImageResizeResult> {
  const originalSize = buffer.length;
  const originalDimensions = getImageDimensions(buffer) ?? { width: 0, height: 0 };
  const originalMediaType = detectMediaType(buffer) ?? 'image/png';

  // If already within limits, return as-is
  if (buffer.length <= targetSize &&
      originalDimensions.width <= maxDimension &&
      originalDimensions.height <= maxDimension) {
    return {
      buffer,
      mediaType: originalMediaType,
      width: originalDimensions.width,
      height: originalDimensions.height,
      originalWidth: originalDimensions.width,
      originalHeight: originalDimensions.height,
      wasResized: false,
      sizeReduction: 0,
    };
  }

  // Read image with Jimp for processing
  const image = await Jimp.read(buffer);
  let { width: imgWidth, height: imgHeight } = image;

  // Calculate scale factor to fit within max dimension
  let scale = 1;
  if (imgWidth > maxDimension || imgHeight > maxDimension) {
    const scaleX = maxDimension / imgWidth;
    const scaleY = maxDimension / imgHeight;
    scale = Math.min(scaleX, scaleY);
  }

  // Resize if needed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processedImage: any = image;
  if (scale < 1) {
    const newWidth = Math.round(imgWidth * scale);
    const newHeight = Math.round(imgHeight * scale);
    processedImage = image.resize({ w: newWidth, h: newHeight });
    imgWidth = newWidth;
    imgHeight = newHeight;
  }

  // Try different quality levels to hit target size
  let quality = 85;
  let resultBuffer = Buffer.from(await processedImage.quality(quality).getBuffer(`image/${originalMediaType.split('/')[1]}`));

  // If still too large, progressively reduce quality and/or scale
  while (resultBuffer.length > targetSize && quality > 20) {
    quality -= 10;
    resultBuffer = Buffer.from(await processedImage.quality(quality).getBuffer(`image/${originalMediaType.split('/')[1]}`));

    // If quality reduction isn't enough, also scale down
    if (resultBuffer.length > targetSize && quality <= 50) {
      const newScale = Math.sqrt(targetSize / resultBuffer.length) * 0.9;
      const newWidth = Math.round(imgWidth * newScale);
      const newHeight = Math.round(imgHeight * newScale);
      processedImage = image.resize({ w: newWidth, h: newHeight });
      imgWidth = newWidth;
      imgHeight = newHeight;
      scale *= newScale;
    }
  }

  // If still too large, convert to JPEG (better compression) and reduce further
  const JPEG_MIME = 'image/jpeg';
  if (resultBuffer.length > targetSize && originalMediaType !== 'image/jpeg') {
    // Convert to JPEG for better compression
    processedImage = await Jimp.read(resultBuffer);
    imgWidth = processedImage.width;
    imgHeight = processedImage.height;
    quality = 80;
    resultBuffer = Buffer.from(await processedImage.quality(quality).getBuffer(JPEG_MIME));

    while (resultBuffer.length > targetSize && quality > 20) {
      quality -= 10;
      resultBuffer = Buffer.from(await processedImage.quality(quality).getBuffer(JPEG_MIME));

      if (resultBuffer.length > targetSize && quality <= 50) {
        const newScale = Math.sqrt(targetSize / resultBuffer.length) * 0.9;
        const newWidth = Math.round(imgWidth * newScale);
        const newHeight = Math.round(imgHeight * newScale);
        processedImage = image.resize({ w: newWidth, h: newHeight });
        imgWidth = newWidth;
        imgHeight = newHeight;
      }
    }

    // If JPEG still too large, accept the size (can't compress further without quality loss making it useless)
    // Just log warning - model will handle the large input
  }

  const finalMediaType = originalMediaType !== 'image/jpeg' && resultBuffer.length > targetSize
    ? 'image/jpeg'
    : originalMediaType;

  return {
    buffer: resultBuffer,
    mediaType: finalMediaType,
    width: imgWidth,
    height: imgHeight,
    originalWidth: originalDimensions.width,
    originalHeight: originalDimensions.height,
    wasResized: scale < 1 || resultBuffer.length < originalSize,
    sizeReduction: originalSize - resultBuffer.length,
  };
}

/**
 * Check if an image needs resizing without fully decoding it
 */
export function needsResizing(buffer: Buffer): boolean {
  const dimensions = getImageDimensions(buffer);
  if (!dimensions) return false;

  return dimensions.width > MAX_IMAGE_DIMENSION ||
         dimensions.height > MAX_IMAGE_DIMENSION ||
         buffer.length > TARGET_IMAGE_SIZE_BYTES;
}
