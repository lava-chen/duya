import { describe, expect, it } from 'vitest';
import { parseEvaluationResult } from '../../src/self-improver/SelfImprover.js';

describe('parseEvaluationResult', () => {
  it('parses a report after stream fragments are assembled', () => {
    const streamedReport = [
      'I ran the requested task.\n```json\n{\n  "score": 8,\n',
      '  "passed": true,\n  "feedback": "The workflow completed successfully.",\n',
      '  "executed_task": "Ran the documented smoke check"\n}\n```',
    ].join('');

    expect(parseEvaluationResult(streamedReport)).toEqual({
      score: 8,
      passed: true,
      feedback: 'The workflow completed successfully.',
      executedTask: 'Ran the documented smoke check',
      dimensions: undefined,
    });
  });

  it('rejects an incomplete stream fragment instead of inventing a failure result', () => {
    expect(parseEvaluationResult('```json\n{ "score": 8,')).toBeNull();
  });
});
