import { describe, it, expect, vi } from 'vitest';
import {
  COMPOSER_SELECTION_STATE_KEY,
  parseComposerSelection,
  readComposerSelection,
  writeComposerSelection,
  isComposerBackendId,
} from './composer-selection';

describe('isComposerBackendId', () => {
  it('accepts known backends', () => {
    for (const id of ['claude', 'grok', 'kiro', 'codex', 'opencode']) {
      expect(isComposerBackendId(id)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isComposerBackendId('gemini')).toBe(false);
    expect(isComposerBackendId(null)).toBe(false);
    expect(isComposerBackendId(1)).toBe(false);
  });
});

describe('parseComposerSelection', () => {
  it('parses a valid selection with model', () => {
    expect(parseComposerSelection({ backend: 'grok', model: 'grok-4' })).toEqual({
      backend: 'grok',
      model: 'grok-4',
    });
  });

  it('normalizes empty/missing model to null', () => {
    expect(parseComposerSelection({ backend: 'claude' })).toEqual({
      backend: 'claude',
      model: null,
    });
    expect(parseComposerSelection({ backend: 'claude', model: '' })).toEqual({
      backend: 'claude',
      model: null,
    });
    expect(parseComposerSelection({ backend: 'claude', model: null })).toEqual({
      backend: 'claude',
      model: null,
    });
  });

  it('rejects unknown backends and malformed payloads', () => {
    expect(parseComposerSelection(undefined)).toBeNull();
    expect(parseComposerSelection(null)).toBeNull();
    expect(parseComposerSelection({ backend: 'nope' })).toBeNull();
    expect(parseComposerSelection({ model: 'x' })).toBeNull();
    expect(parseComposerSelection('grok')).toBeNull();
  });
});

describe('readComposerSelection / writeComposerSelection', () => {
  it('reads a stored selection', () => {
    const store = {
      get: vi.fn().mockReturnValue({ backend: 'grok', model: 'm1' }),
      update: vi.fn(),
    };
    expect(readComposerSelection(store)).toEqual({ backend: 'grok', model: 'm1' });
    expect(store.get).toHaveBeenCalledWith(COMPOSER_SELECTION_STATE_KEY);
  });

  it('returns null when store is empty or invalid', () => {
    expect(readComposerSelection({ get: () => undefined, update: () => undefined })).toBeNull();
    expect(readComposerSelection({ get: () => ({ backend: 'x' }), update: () => undefined })).toBeNull();
  });

  it('writes a normalized selection', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    await writeComposerSelection({ get: () => undefined, update }, { backend: 'opencode', model: null });
    expect(update).toHaveBeenCalledWith(COMPOSER_SELECTION_STATE_KEY, {
      backend: 'opencode',
      model: null,
    });
  });

  it('swallows write failures', async () => {
    await expect(
      writeComposerSelection(
        {
          get: () => undefined,
          update: () => {
            throw new Error('boom');
          },
        },
        { backend: 'claude', model: null },
      ),
    ).resolves.toBeUndefined();
  });
});
