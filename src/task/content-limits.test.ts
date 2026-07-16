import { describe, expect, it } from 'vitest';
import {
  TASK_ERROR_MAX_BYTES,
  TASK_RESULT_MAX_BYTES,
  truncateUtf8Bytes,
} from './content-limits';
import { buildTaskResultFromSummary } from './dataflow';

describe('canonical UTF-8 content limits', () => {
  it('clamps multibyte text by bytes without splitting code points', () => {
    const result = truncateUtf8Bytes('🙂'.repeat(10_000), TASK_ERROR_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(TASK_ERROR_MAX_BYTES);
    expect(result.text).not.toContain('�');
  });

  it('marks persisted task results when canonical result cap truncates', () => {
    const result = buildTaskResultFromSummary('界'.repeat(TASK_RESULT_MAX_BYTES));
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.summary, 'utf8')).toBeLessThanOrEqual(TASK_RESULT_MAX_BYTES);
  });
});
