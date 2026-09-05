import { describe, expect, it } from 'vitest';
import {
  isModelLikelyMultimodal,
  isMultimodalRejectionError,
  NON_MULTIMODAL_MODEL_PATTERNS,
} from '../multimodal-detection.js';

describe('isModelLikelyMultimodal', () => {
  it('treats the GLM 4.5+ chat family as multimodal (incl. flash variants)', () => {
    for (const model of [
      'glm-4.5',
      'glm-4.5-air',
      'glm-4.5-flash',
      'glm-4.6',
      'glm-4.7',
      'glm-5',
      'glm-5.1',
      'glm-5.3',
      'glm-5.3-flash',
    ]) {
      expect(isModelLikelyMultimodal(model), model).toBe(true);
    }
  });

  it('treats GLM-4V vision models as multimodal', () => {
    expect(isModelLikelyMultimodal('glm-4v')).toBe(true);
    expect(isModelLikelyMultimodal('glm-4v-flash')).toBe(true);
    expect(isModelLikelyMultimodal('glm-4v-plus')).toBe(true);
  });

  it('leaves GLM-3.x and unknown names unmatched (falls through to probe)', () => {
    expect(isModelLikelyMultimodal('glm-3-turbo')).toBe(false);
    expect(isModelLikelyMultimodal('chatglm3-6b')).toBe(false);
    expect(isModelLikelyMultimodal('some-text-model')).toBe(false);
  });

  it('keeps known non-multimodal families negative', () => {
    for (const model of ['deepseek-chat', 'gpt-3.5-turbo', 'mistral-7b']) {
      expect(isModelLikelyMultimodal(model), model).toBe(false);
    }
    expect(NON_MULTIMODAL_MODEL_PATTERNS.some((p) => p.test('glm-5.3-flash'))).toBe(false);
  });
});

describe('isMultimodalRejectionError', () => {
  it('recognizes image rejection messages', () => {
    expect(isMultimodalRejectionError('This model does not support image input.')).toBe(true);
    expect(isMultimodalRejectionError('invalid content type: image')).toBe(true);
    expect(isMultimodalRejectionError('rate limit exceeded')).toBe(false);
  });
});
