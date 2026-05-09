/**
 * Centralized application constants
 * Single source of truth for magic numbers and configuration values
 */

// ==================== Session Locking ====================

/** Lock TTL in seconds (5 minutes) */
export const LOCK_TTL_SEC = 300;

/** Lock renewal interval in milliseconds (60 seconds) */
export const LOCK_RENEWAL_INTERVAL_MS = 60_000;

/** Stream idle timeout in milliseconds (280 seconds)
 * Must be LESS than LOCK_TTL_SEC to prevent race condition where
 * idle timeout fires AFTER lock expires but BEFORE new request acquires lock */
export const STREAM_IDLE_TIMEOUT_MS = 280_000;

// ==================== File Upload ====================

/** Maximum file upload size: 10MB */
export const FILE_UPLOAD_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/** Allowed MIME types for file uploads */
export const FILE_UPLOAD_ALLOWED_TYPES = new Set([
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Text
  'text/plain',
  'text/markdown',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  // Documents
  'application/pdf',
  // Code
  'application/typescript',
  'application/javascript',
  'text/typescript',
]);

/** Maximum filename length */
export const FILE_UPLOAD_MAX_FILENAME_LENGTH = 255;

// ==================== Context Compression ====================

/** Minimum messages before compression check */
export const CONTEXT_COMPRESSION_MIN_MESSAGES = 10;

/** Context usage threshold to trigger compression (80%) */
export const CONTEXT_COMPRESSION_THRESHOLD = 0.8;

// ==================== SSE Streaming ====================

/** SSE keepalive interval in milliseconds */
export const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

// ==================== Tool Execution ====================

/** Default tool timeout in seconds (5 minutes) */
export const TOOL_TIMEOUT_SEC = 300;

/** Tool timeout warning threshold in seconds (90 seconds) */
export const TOOL_TIMEOUT_WARNING_SEC = 90;

// ==================== Permission System ====================

/** Permission request timeout in milliseconds (5 minutes) */
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

// ==================== Sync & Hydration ====================

/** Stale threshold for hydration in milliseconds (30 seconds) */
export const HYDRATION_STALE_TIME_MS = 30_000;

// ==================== Default Model ====================

/** Default model value from database - used to detect unset model */
export const DB_DEFAULT_MODEL = 'claude-sonnet-4-20250514';

// ==================== Feature Flags ====================

/**
 * Feature flag: Use SSE fallback when MessagePort is not available
 * Set to 'true' to always use SSE, 'false' to prefer MessagePort
 */
export const DUYA_USE_SSE_FALLBACK = import.meta.env.VITE_DUYA_USE_SSE_FALLBACK === 'true';

/**
 * Check if MessagePort is available for Agent communication
 */
export const isAgentPortAvailable = (): boolean => {
  return !!window.electronAPI?.getAgentPort?.();
};
