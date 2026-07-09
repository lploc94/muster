import { describe, it, expect } from 'vitest';
import { extractModelConfig } from './acp-client';

describe('extractModelConfig', () => {
  it('extracts the model option from a session/new configOptions array', () => {
    const configOptions = [
      { id: 'mode', category: 'mode', options: [{ value: 'ask', name: 'Ask' }] },
      {
        id: 'model',
        category: 'model',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default (recommended)', description: 'x' },
          { value: 'opus[1m]', name: 'Opus' },
        ],
      },
    ];
    expect(extractModelConfig(configOptions)).toEqual({
      id: 'model',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default (recommended)', description: 'x' },
        { value: 'opus[1m]', name: 'Opus', description: undefined },
      ],
    });
  });

  it('returns undefined when there is no model-category option', () => {
    expect(extractModelConfig([{ id: 'mode', category: 'mode', options: [] }])).toBeUndefined();
  });

  it('returns undefined for non-array / missing input', () => {
    expect(extractModelConfig(undefined)).toBeUndefined();
    expect(extractModelConfig({})).toBeUndefined();
    expect(extractModelConfig(null)).toBeUndefined();
  });

  it('skips malformed option entries and drops the option if none remain valid', () => {
    const good = extractModelConfig([
      { id: 'model', category: 'model', options: [{ value: 'a', name: 'A' }, { value: 1, name: 'bad' }, null] },
    ]);
    expect(good).toEqual({ id: 'model', currentValue: undefined, options: [{ value: 'a', name: 'A', description: undefined }] });

    const empty = extractModelConfig([{ id: 'model', category: 'model', options: [{ value: 1 }, {}] }]);
    expect(empty).toBeUndefined();
  });
});
