import { describe, it, expect } from 'vitest'
import { buildImageAttachmentContext } from './image-attachment-context'

const files = [
  { name: 'a.png' },
  { name: 'b.png' },
  { name: 'c.png' },
  { name: 'd.png' },
  { name: 'e.png' },
]

describe('buildImageAttachmentContext', () => {
  describe('multimodal model', () => {
    it('reports only read-failures; ignores CDN-skip and vision-fail (vision does not run)', () => {
      const result = buildImageAttachmentContext({
        imageFiles: files,
        analyzedFileNames: new Set(),
        cdnSkipped: new Set(['a.png', 'b.png']),
        readFailed: new Set(['c.png']),
        visionFailed: new Set(['d.png', 'e.png']),
        modelIsMultimodal: true,
        hasVisionAnalyzer: false,
      })

      expect(result.hasUnprocessedImages).toBe(true)
      expect(result.appendText).toContain('1 image file(s) could not be read from disk (c.png)')
      // CDN-skipped must NOT appear: main model will see image blocks.
      expect(result.appendText).not.toContain('CDN')
      expect(result.appendText).not.toContain('a.png')
      expect(result.appendText).not.toContain('b.png')
    })

    it('returns empty when all images read successfully', () => {
      const result = buildImageAttachmentContext({
        imageFiles: files,
        analyzedFileNames: new Set(),
        cdnSkipped: new Set(),
        readFailed: new Set(),
        visionFailed: new Set(),
        modelIsMultimodal: true,
        hasVisionAnalyzer: false,
      })

      expect(result.appendText).toBe('')
      expect(result.hasUnprocessedImages).toBe(false)
    })
  })

  describe('non-multimodal model with vision analyzer', () => {
    it('reports partial vision success distinctly from failures', () => {
      // 2 of 5 images analyzed; 3 vision-failed.
      const result = buildImageAttachmentContext({
        imageFiles: files,
        analyzedFileNames: new Set(['a.png', 'b.png']),
        cdnSkipped: new Set(),
        readFailed: new Set(),
        visionFailed: new Set(['c.png', 'd.png', 'e.png']),
        modelIsMultimodal: false,
        hasVisionAnalyzer: true,
        visionAnalysisError: 'API rate limit',
      })

      expect(result.hasUnprocessedImages).toBe(true)
      // "succeeded for 2 of 5" — proves partial-success is now visible.
      expect(result.appendText).toContain('Vision analysis succeeded for 2 of 5 image(s)')
      expect(result.appendText).toContain('failed for 3')
      expect(result.appendText).toContain('API rate limit')
    })

    it('reports all-vision-failed without claiming partial success', () => {
      const result = buildImageAttachmentContext({
        imageFiles: files,
        analyzedFileNames: new Set(),
        cdnSkipped: new Set(),
        readFailed: new Set(),
        visionFailed: new Set(['a.png', 'b.png', 'c.png']),
        modelIsMultimodal: false,
        hasVisionAnalyzer: true,
        visionAnalysisError: 'model unavailable',
      })

      expect(result.appendText).toContain('Vision analysis failed for all 3 image(s)')
      expect(result.appendText).not.toContain('succeeded for')
    })

    it('attributes CDN-skip separately from vision failure when both occur', () => {
      // 1 analyzed, 1 CDN-skipped, 1 vision-failed, 2 read-failed.
      const result = buildImageAttachmentContext({
        imageFiles: files,
        analyzedFileNames: new Set(['a.png']),
        cdnSkipped: new Set(['b.png']),
        readFailed: new Set(['c.png', 'd.png']),
        visionFailed: new Set(['e.png']),
        modelIsMultimodal: false,
        hasVisionAnalyzer: true,
      })

      expect(result.appendText).toContain('Vision analysis succeeded for 1 of 5')
      expect(result.appendText).toContain('Skipped (CDN URL, no local data): b.png')
      expect(result.appendText).toContain('Unable to read from disk: c.png, d.png')
      // The vision-failed file is counted in the succeeded-vs-failed summary
      // and not double-counted under CDN/read.
      expect(result.appendText).toContain('failed for 1')
    })
  })

  describe('non-multimodal model without vision analyzer', () => {
    it('enumerates every image and every reason', () => {
      const result = buildImageAttachmentContext({
        imageFiles: files,
        analyzedFileNames: new Set(),
        cdnSkipped: new Set(['a.png', 'b.png']),
        readFailed: new Set(['c.png']),
        visionFailed: new Set(),
        modelIsMultimodal: false,
        hasVisionAnalyzer: false,
      })

      expect(result.hasUnprocessedImages).toBe(true)
      expect(result.appendText).toContain('no vision model is configured')
      // All images must be listed by name so the model knows they exist.
      expect(result.appendText).toContain('a.png')
      expect(result.appendText).toContain('b.png')
      expect(result.appendText).toContain('c.png')
      expect(result.appendText).toContain('d.png')
      expect(result.appendText).toContain('e.png')
      // Bucket attribution must be present.
      expect(result.appendText).toContain('Skipped (CDN URL, no local data): a.png, b.png')
      expect(result.appendText).toContain('Unable to read from disk: c.png')
    })

    it('returns empty when no images are present', () => {
      const result = buildImageAttachmentContext({
        imageFiles: [],
        analyzedFileNames: new Set(),
        cdnSkipped: new Set(),
        readFailed: new Set(),
        visionFailed: new Set(),
        modelIsMultimodal: false,
        hasVisionAnalyzer: false,
      })

      expect(result.appendText).toBe('')
      expect(result.hasUnprocessedImages).toBe(false)
    })
  })

  describe('analysis-set semantics', () => {
    it('does not double-count a file that was analyzed AND then attributed to read-failed', () => {
      // Defensive case: if a file name ends up in both analyzedFileNames and
      // readFailed (e.g. cache eviction between Phase 2 and Phase 3), the
      // helper should prefer "analyzed" — preAnalysisText already covers it.
      const result = buildImageAttachmentContext({
        imageFiles: files,
        analyzedFileNames: new Set(['a.png']),
        cdnSkipped: new Set(),
        readFailed: new Set(['a.png']),
        visionFailed: new Set(),
        modelIsMultimodal: true,
        hasVisionAnalyzer: false,
      })

      // Multimodal + read-failed should NOT mention a.png because it was
      // already analyzed (preAnalysisText covers it; image block was added
      // for the multimodal path).
      expect(result.appendText).not.toContain('a.png')
    })
  })
})
