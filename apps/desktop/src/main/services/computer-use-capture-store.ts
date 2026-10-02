/**
 * computer-use-capture-store.ts — Persist capture / zoom PNGs to disk.
 *
 * Every screen image the model sees during a computer-use session is
 * saved under `~/.duya/computer-use/` so the user can audit what the
 * agent was looking at:
 *
 *   ~/.duya/computer-use/<sessionId|nosession>/<yyyy-mm-dd>/<HHmmss>-<action>-<seq>.png
 *
 * Grouping: session first (one folder per agent session), then day,
 * then time-of-day filename. Saving is best-effort: a failure logs a
 * WARN and returns null — the tool result still carries the base64
 * image for the model, so a disk error must never break the session.
 *
 * Path safety: sessionId comes from the agent payload, i.e. model-
 * influenced input. Every dynamic segment is validated against a
 * strict allowlist inline, and each resolved fs target is verified to
 * stay inside the storage root immediately before use.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

/** Monotonic per-second sequence so same-second captures don't collide. */
let seq = 0;
let lastSecond = -1;

function nextSeq(): number {
  const second = Math.floor(Date.now() / 1000);
  if (second !== lastSecond) {
    lastSecond = second;
    seq = 0;
  }
  return ++seq;
}

/** Allowlist for a single path segment derived from untrusted input. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface CaptureSaveRequest {
  sessionId?: string;
  action: 'capture' | 'zoom';
  base64: string;
}

/**
 * Write the PNG to the session/day folder and return the absolute
 * path, or null when saving failed (or the image is empty).
 */
export function saveComputerUseCapture(req: CaptureSaveRequest): string | null {
  if (!req.base64) return null;
  try {
    // Untrusted segment: sanitize + verify inline, before any path join.
    const sessionSegment = (req.sessionId ?? '')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 64) || 'nosession';
    if (!SAFE_SEGMENT_RE.test(sessionSegment)) {
      logger.warn(
        'computer-use: capture refused — unsafe session segment',
        { sessionId: req.sessionId ?? null },
        LogComponent.ComputerUse,
      );
      return null;
    }

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    const root = path.resolve(os.homedir(), '.duya', 'computer-use');
    const dir = path.resolve(root, sessionSegment, day);
    if (!dir.startsWith(root + path.sep)) {
      logger.warn(
        'computer-use: capture dir escaped storage root — refused',
        { sessionId: req.sessionId ?? null },
        LogComponent.ComputerUse,
      );
      return null;
    }

    const file = `${hh}${mm}${ss}-${req.action}-${nextSeq()}.png`;
    const filePath = path.resolve(dir, file);
    if (!filePath.startsWith(root + path.sep)) {
      logger.warn(
        'computer-use: capture file escaped storage root — refused',
        { sessionId: req.sessionId ?? null },
        LogComponent.ComputerUse,
      );
      return null;
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(req.base64, 'base64'));

    logger.debug(
      'computer-use: capture saved',
      { path: filePath, action: req.action, sessionId: req.sessionId ?? null },
      LogComponent.ComputerUse,
    );
    return filePath;
  } catch (err) {
    logger.warn(
      'computer-use: failed to save capture image',
      {
        action: req.action,
        sessionId: req.sessionId ?? null,
        error: err instanceof Error ? err.message : String(err),
      },
      LogComponent.ComputerUse,
    );
    return null;
  }
}
