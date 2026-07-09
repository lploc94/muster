import { describe, it, expect } from 'vitest';
import {
  extractModelConfig,
  extractModelConfigFromOptions,
  extractModelConfigFromSessionModels,
} from './acp-client';

describe('extractModelConfig (configOptions)', () => {
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
      applyVia: 'config_option',
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
    expect(good).toEqual({
      id: 'model',
      applyVia: 'config_option',
      currentValue: undefined,
      options: [{ value: 'a', name: 'A', description: undefined }],
    });

    const empty = extractModelConfig([{ id: 'model', category: 'model', options: [{ value: 1 }, {}] }]);
    expect(empty).toBeUndefined();
  });
});

describe('extractModelConfigFromSessionModels (Grok/Kiro shape)', () => {
  it('extracts availableModels + currentModelId', () => {
    const models = {
      currentModelId: 'grok-4.5',
      availableModels: [
        { modelId: 'grok-4.5', name: 'Grok 4.5', description: 'frontier' },
        { modelId: 'grok-composer-2.5-fast', name: 'Composer 2.5' },
      ],
    };
    expect(extractModelConfigFromSessionModels(models)).toEqual({
      id: 'model',
      applyVia: 'session_set_model',
      currentValue: 'grok-4.5',
      options: [
        { value: 'grok-4.5', name: 'Grok 4.5', description: 'frontier' },
        { value: 'grok-composer-2.5-fast', name: 'Composer 2.5', description: undefined },
      ],
    });
  });

  it('accepts id / value aliases and falls back name to modelId', () => {
    expect(
      extractModelConfigFromSessionModels({
        availableModels: [{ id: 'auto' }, { value: 'claude-opus-4.8', name: 'Opus' }],
      }),
    ).toEqual({
      id: 'model',
      applyVia: 'session_set_model',
      currentValue: undefined,
      options: [
        { value: 'auto', name: 'auto', description: undefined },
        { value: 'claude-opus-4.8', name: 'Opus', description: undefined },
      ],
    });
  });

  it('returns undefined when availableModels is empty or missing', () => {
    expect(extractModelConfigFromSessionModels({})).toBeUndefined();
    expect(extractModelConfigFromSessionModels({ availableModels: [] })).toBeUndefined();
    expect(extractModelConfigFromSessionModels(null)).toBeUndefined();
  });
});

describe('extractModelConfig combined', () => {
  it('prefers configOptions over session.models', () => {
    const fromOptions = extractModelConfigFromOptions([
      { id: 'model', category: 'model', options: [{ value: 'sonnet', name: 'Sonnet' }] },
    ]);
    const combined = extractModelConfig(
      [{ id: 'model', category: 'model', options: [{ value: 'sonnet', name: 'Sonnet' }] }],
      { currentModelId: 'grok-4.5', availableModels: [{ modelId: 'grok-4.5', name: 'Grok' }] },
    );
    expect(combined).toEqual(fromOptions);
    expect(combined?.applyVia).toBe('config_option');
  });

  it('falls back to session.models when configOptions has no model', () => {
    const combined = extractModelConfig(
      [{ id: 'mode', category: 'mode', options: [] }],
      { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'auto' }] },
    );
    expect(combined?.applyVia).toBe('session_set_model');
    expect(combined?.options).toEqual([{ value: 'auto', name: 'auto', description: undefined }]);
  });
});
