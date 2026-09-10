/**
 * image-attachment-context.ts
 *
 * Pure helper for building the [System: ...] context block that tells the
 * main model exactly which images it received, which it could see, and why
 * any images are unavailable.
 *
 * Why a separate module: agent-process-entry.ts is a 4500-line entry-point
 * monolith with no unit-test coverage. This helper isolates the deterministic
 * string-building logic so we can test it directly without standing up an
 * agent process. The companion `buildImageAttachmentContext.test.ts` pins the
 * exact prompt shape so future refactors don't regress the message the user
 * (or their main model) sees when vision paths fail.
 *
 * Inputs are normalized into three skip-reason buckets. The output is one or
 * more [System: ...] blocks; callers append them to the effective prompt.
 *
 * Buckets:
 *   - cdnSkipped: URLs that matched isCDNImageUrl (no local data available).
 *   - readFailed: local files we could not load from disk.
 *   - visionFailed: local files we could load but the vision model rejected
 *     (API error, timeout, oversize, etc).
 *
 * Successful files contribute nothing to this helper — they are either
 * inlined as image content blocks (multimodal) or surfaced via
 * `preAnalysisText` (non-multimodal) by the caller.
 */

export interface ImageAttachmentContextInput {
  /** All image attachments the user sent, in original order. */
  imageFiles: ReadonlyArray<{ readonly name: string }>;
  /** Names already covered by pre-analysis text (so we don't double-count). */
  analyzedFileNames: ReadonlySet<string>;
  cdnSkipped: ReadonlySet<string>;
  readFailed: ReadonlySet<string>;
  visionFailed: ReadonlySet<string>;
  /** True when the main model can consume image blocks natively. */
  modelIsMultimodal: boolean;
  /** True when the agent has any vision analyzer available at all. */
  hasVisionAnalyzer: boolean;
  /** First failure message from vision, if any. */
  visionAnalysisError?: string | null;
}

export interface ImageAttachmentContextOutput {
  /** Text to append to effectivePrompt. May be empty. */
  appendText: string;
  /** True when at least one image could not be processed. */
  hasUnprocessedImages: boolean;
}

interface FileLike {
  readonly name: string;
}

/**
 * Build the [System: ...] block(s) describing image attachments the main
 * model cannot see directly. Returns empty string when every image is either
 * already covered by pre-analysis, inlined via image blocks (multimodal),
 * or absent.
 */
export function buildImageAttachmentContext(
  input: ImageAttachmentContextInput,
): ImageAttachmentContextOutput {
  // Early exit: nothing to explain if no images were attached at all.
  if (input.imageFiles.length === 0) {
    return { appendText: '', hasUnprocessedImages: false };
  }

  const blocks: string[] = [];

  const cdnNames = namesOf(input.imageFiles, input.cdnSkipped, input.analyzedFileNames);
  const readNames = namesOf(input.imageFiles, input.readFailed, input.analyzedFileNames);
  const visionNames = namesOf(input.imageFiles, input.visionFailed, input.analyzedFileNames);

  const totalUnprocessed = cdnNames.length + readNames.length + visionNames.length;
  const hasUnprocessedImages = totalUnprocessed > 0;

  // Multimodal path: only read-failures matter (CDN-skipped is irrelevant —
  // main model will see the image block; vision failures never happen because
  // we don't run pre-analysis for multimodal models).
  if (input.modelIsMultimodal) {
    if (readNames.length > 0) {
      blocks.push(
        `\n\n[System: Note: ${readNames.length} image file(s) could not be read from disk (${readNames.join(', ')}). Only successfully read images are shown.]`,
      );
    }
    return { appendText: blocks.join(''), hasUnprocessedImages: readNames.length > 0 };
  }

  // Non-multimodal path: every skip reason needs an explanation because the
  // main model will rely on text context alone.
  if (input.hasVisionAnalyzer) {
    // Vision analyzer is configured — so either it produced text (handled
    // separately by the caller) or it failed. Distinguish the two cases.
    if (visionNames.length > 0) {
      const errorDetail = input.visionAnalysisError ? ` Error: ${input.visionAnalysisError}.` : '';
      const partiallyAnalyzed = input.analyzedFileNames.size > 0;
      const summary = partiallyAnalyzed
        ? `Vision analysis succeeded for ${input.analyzedFileNames.size} of ${input.imageFiles.length} image(s); failed for ${visionNames.length}.`
        : `Vision analysis failed for all ${visionNames.length} image(s).`;
      // Also surface any CDN-skip / read-failed images alongside the vision
      // summary — they are separate from the vision pass and the main model
      // needs to know about them too.
      const ancillaryCdn = cdnNames;
      const ancillaryRead = readNames;
      blocks.push(
        `\n\n[System: Image analysis is unavailable.${errorDetail} ${summary} ` +
          'The configured vision model failed to analyze the uploaded image(s), ' +
          'and the main model does not support direct image input. ' +
          (ancillaryCdn.length > 0
            ? ` Skipped (CDN URL, no local data): ${ancillaryCdn.join(', ')}.`
            : '') +
          (ancillaryRead.length > 0
            ? ` Unable to read from disk: ${ancillaryRead.join(', ')}.`
            : '') +
          'Please check your vision model settings or switch to a multimodal model ' +
          '(e.g. Claude, GPT-4V, Gemini).]',
      );
    } else if (totalUnprocessed > 0) {
      // Edge case: vision analyzer configured but no vision failures
      // recorded — only CDN/read failures to attribute.
      blocks.push(buildCdnOrReadOnlyBlock(input.imageFiles, cdnNames, readNames));
    }
  } else {
    // No vision analyzer at all. Tell the main model about every image and
    // every reason so it knows nothing was processed.
    const imageNames = input.imageFiles.map((f) => f.name);
    const parts: string[] = [];
    parts.push(
      `\n\n[System: The user sent ${input.imageFiles.length} image file(s): ${imageNames.join(', ')}.`,
    );
    parts.push('This model cannot view images directly and no vision model is configured.');
    if (cdnNames.length > 0) {
      parts.push(`Skipped (CDN URL, no local data): ${cdnNames.join(', ')}.`);
    }
    if (readNames.length > 0) {
      parts.push(`Unable to read from disk: ${readNames.join(', ')}.`);
    }
    parts.push(
      'Please configure a vision model in Settings or use a multimodal model (e.g. Claude, GPT-4V, Gemini) to process images.]',
    );
    blocks.push(parts.join(' '));
  }

  return { appendText: blocks.join(''), hasUnprocessedImages };
}

function namesOf(
  imageFiles: ReadonlyArray<FileLike>,
  skipSet: ReadonlySet<string>,
  analyzedSet: ReadonlySet<string>,
): string[] {
  return imageFiles
    .filter((f) => skipSet.has(f.name) && !analyzedSet.has(f.name))
    .map((f) => f.name);
}

function buildCdnOrReadOnlyBlock(
  imageFiles: ReadonlyArray<FileLike>,
  cdnNames: string[],
  readNames: string[],
): string {
  const imageNames = imageFiles.map((f) => f.name);
  const parts: string[] = [];
  parts.push(
    `\n\n[System: The user sent ${imageFiles.length} image file(s): ${imageNames.join(', ')}.`,
  );
  parts.push('This model cannot view images directly.');
  if (cdnNames.length > 0) {
    parts.push(`Skipped (CDN URL, no local data): ${cdnNames.join(', ')}.`);
  }
  if (readNames.length > 0) {
    parts.push(`Unable to read from disk: ${readNames.join(', ')}.`);
  }
  parts.push('Please configure a vision model in Settings or use a multimodal model.]');
  return parts.join(' ');
}
