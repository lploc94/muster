import { describe, expect, it } from 'vitest';
import type { Backend } from '../types';
import { selectCommittedSessionId } from './session-select';

function backend(extract?: (raw: string, last?: string) => string | undefined): Backend {
  return {
    name: 'fake',
    extractSessionId: extract,
    run: async function* () {},
  };
}

describe('selectCommittedSessionId', () => {
  it('prefers observedSessionId from sessionStarted', () => {
    expect(
      selectCommittedSessionId(
        backend(() => 'extracted'),
        { observedSessionId: 'observed-1' },
        'raw',
        'prior-1',
      ),
    ).toBe('observed-1');
  });

  it('falls back to extractSessionId when no observed id', () => {
    expect(
      selectCommittedSessionId(backend(() => 'extracted'), {}, 'raw-lines', 'prior-1'),
    ).toBe('extracted');
  });

  it('falls back to priorCommittedId when nothing else is available', () => {
    expect(selectCommittedSessionId(backend(), {}, '', 'prior-1')).toBe('prior-1');
  });

  it('does not invent a committed id on a failed first turn', () => {
    expect(
      selectCommittedSessionId(backend(() => 'candidate-only'), {}, 'raw', undefined),
    ).toBe('candidate-only');
    expect(selectCommittedSessionId(backend(), {}, '', undefined)).toBeUndefined();
  });
});