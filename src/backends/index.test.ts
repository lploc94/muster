import { describe, expect, it } from 'vitest';
import { makeBackend } from './index';

describe('makeBackend', () => {
  it('rejects unknown backend ids instead of defaulting to Claude', () => {
    expect(() => makeBackend('unknown-provider')).toThrow(/unsupported backend: unknown-provider/);
  });
});
