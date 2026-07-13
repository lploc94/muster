import { describe, expect, it } from 'vitest';
import {
  encodeGrokAnswers,
  isAskLikeForm,
  normalizeAgentQuestions,
  parseElicitationCreate,
  parseUrlElicitationRequiredEntries,
  validateFormValues,
} from './elicitation';

describe('parseElicitationCreate', () => {
  it('parses form selection schema', () => {
    const result = parseElicitationCreate({
      sessionId: 's1',
      mode: 'form',
      message: 'How to proceed?',
      requestedSchema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            title: 'Strategy',
            oneOf: [
              { const: 'a', title: 'A' },
              { const: 'b', title: 'B' },
            ],
          },
        },
        required: ['strategy'],
      },
    });
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') return;
    expect(result.fields[0]?.type).toBe('enum');
    expect(result.fields[0]?.options).toEqual(['a', 'b']);
    expect(isAskLikeForm(result)).toBe(true);
  });

  it('parses url mode', () => {
    const result = parseElicitationCreate({
      requestId: 12,
      mode: 'url',
      elicitationId: 'oauth-1',
      url: 'https://example.com/connect',
      message: 'Authorize',
    });
    expect(result).toMatchObject({
      kind: 'url',
      elicitationId: 'oauth-1',
      requestId: 12,
    });
  });

  it('rejects dual scope', () => {
    const result = parseElicitationCreate({
      sessionId: 's',
      requestId: 'r',
      mode: 'form',
      message: 'x',
    });
    expect(result.kind).toBe('error');
  });

  it('rejects url without elicitationId', () => {
    const result = parseElicitationCreate({
      sessionId: 's',
      mode: 'url',
      url: 'https://example.com',
    });
    expect(result.kind).toBe('error');
  });
});

describe('parseUrlElicitationRequiredEntries', () => {
  it('parses -32042 entries without session scope', () => {
    const result = parseUrlElicitationRequiredEntries({
      elicitations: [
        {
          mode: 'url',
          elicitationId: 'e1',
          url: 'https://example.com/a',
          message: 'Auth',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.elicitationId).toBe('e1');
  });
});

describe('validateFormValues', () => {
  it('enforces multiEnum minItems', () => {
    const form = parseElicitationCreate({
      sessionId: 's',
      mode: 'form',
      message: 'colors',
      requestedSchema: {
        type: 'object',
        properties: {
          colors: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: { type: 'string', enum: ['Red', 'Green', 'Blue'] },
          },
        },
        required: ['colors'],
      },
    });
    expect(form.kind).toBe('form');
    if (form.kind !== 'form') return;
    expect(validateFormValues(form, { colors: [] }).ok).toBe(false);
    expect(validateFormValues(form, { colors: ['Red'] }).ok).toBe(true);
  });
});

describe('normalizeAgentQuestions / encodeGrokAnswers', () => {
  it('round-trips Grok labels', () => {
    const qs = normalizeAgentQuestions([
      { question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    expect(encodeGrokAnswers(qs, { '0': { selected: ['A'], freeText: null } })).toEqual({
      'Pick?': 'A',
    });
  });
});
