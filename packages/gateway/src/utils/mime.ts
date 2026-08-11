/**
 * Shared MIME type mapping by file extension.
 *
 * Single source of truth for extension-based MIME detection across the gateway
 * (attachment building and platform media sending). Both directions are
 * derived from this one map so they can never drift apart.
 */

export const EXT_MIME_MAP: Record<string, string> = {
  // images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  // documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.log': 'text/plain',
  // audio
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  // video
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  // archives
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  // books / packages
  '.epub': 'application/epub+zip',
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
};

// Reverse lookup from MIME type to preferred extension.
export const MIME_EXT_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_MIME_MAP).map(([ext, mime]) => [mime, ext])
);