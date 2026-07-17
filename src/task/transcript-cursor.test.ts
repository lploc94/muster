import { describe, expect, it } from 'vitest';
import {
  InvalidTranscriptCursorError,
  decodeTranscriptCursor,
  encodeTranscriptCursor,
} from './transcript-cursor';
import type { TranscriptSortKey } from './transcript-order';

const SCOPE = { workspaceId: 'ws', taskId: 'task-1' };
const KEY: TranscriptSortKey = {
  turnSequence: 3,
  kindRank: 2,
  ordering: 5,
  createdAt: '2026-07-16T00:00:00.000Z',
  entityId: 'entity-9',
};

/** Encode an arbitrary payload object into a v2 cursor for negative testing. */
function encodePayload(payload: unknown): string {
  return `v2.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

/** A full, valid payload object (all 8 keys) used as the base for mutation tests. */
function validPayload(): Record<string, unknown> {
  return {
    version: 2,
    workspaceId: SCOPE.workspaceId,
    taskId: SCOPE.taskId,
    turnSequence: KEY.turnSequence,
    kindRank: KEY.kindRank,
    ordering: KEY.ordering,
    createdAt: KEY.createdAt,
    entityId: KEY.entityId,
  };
}

describe('transcript cursor v2', () => {
  it('round-trips a valid cursor within scope', () => {
    const cursor = encodeTranscriptCursor(SCOPE, KEY);
    expect(cursor.startsWith('v2.')).toBe(true);
    expect(decodeTranscriptCursor(cursor, SCOPE)).toEqual(KEY);
  });

  it('round-trips the unbound-turn sentinel and rank 0', () => {
    const key: TranscriptSortKey = { ...KEY, turnSequence: -1, kindRank: 0, ordering: -2 };
    const cursor = encodeTranscriptCursor(SCOPE, key);
    expect(decodeTranscriptCursor(cursor, SCOPE)).toEqual(key);
  });

  it('rejects a malformed prefix', () => {
    expect(() => decodeTranscriptCursor('v3.abc', SCOPE)).toThrow(InvalidTranscriptCursorError);
    expect(() => decodeTranscriptCursor('nope', SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects a legacy v1 cursor', () => {
    // A Phase-3 v1 payload (delimiter-joined junk bytes) must never decode under v2.
    const v1 = `v1.${Buffer.from('3\x002\x002026\x00e', 'utf8').toString('base64url')}`;
    expect(() => decodeTranscriptCursor(v1, SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects non-canonical base64url', () => {
    // '+' and '/' and '=' are not in the base64url alphabet.
    expect(() => decodeTranscriptCursor('v2.a+b/c=', SCOPE)).toThrow(InvalidTranscriptCursorError);
    expect(() => decodeTranscriptCursor('v2.', SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects alternate trailing base64 bits (non-canonical encoding)', () => {
    // Canonically encode a payload, then flip the final base64url char to a value
    // that decodes to the same bytes but is not the canonical re-encoding.
    const canonical = encodePayload(validPayload());
    const encoded = canonical.slice('v2.'.length);
    const bytes = Buffer.from(encoded, 'base64url');
    // Build a tampered tail: last char with non-zero unused bits. 'A'..'P' all decode
    // to the same final byte group when trailing bits differ; pick one that changes the
    // char but not the decoded bytes.
    const lastChar = encoded[encoded.length - 1]!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let tampered = encoded;
    for (const c of alphabet) {
      if (c === lastChar) continue;
      const candidate = encoded.slice(0, -1) + c;
      if (Buffer.from(candidate, 'base64url').equals(bytes) && candidate !== encoded) {
        tampered = candidate;
        break;
      }
    }
    if (tampered !== encoded) {
      expect(() => decodeTranscriptCursor(`v2.${tampered}`, SCOPE)).toThrow(InvalidTranscriptCursorError);
    }
  });

  it('rejects invalid UTF-8 bytes in the payload', () => {
    // 0x80 is a lone continuation byte — invalid UTF-8. A lenient decoder would emit
    // U+FFFD and then JSON.parse would fail anyway, but we reject at the decode step.
    const badBytes = Buffer.from([0x80, 0x81, 0x82]);
    const cursor = `v2.${badBytes.toString('base64url')}`;
    expect(() => decodeTranscriptCursor(cursor, SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects invalid JSON', () => {
    const cursor = `v2.${Buffer.from('not json', 'utf8').toString('base64url')}`;
    expect(() => decodeTranscriptCursor(cursor, SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects wrong version in payload', () => {
    expect(() => decodeTranscriptCursor(encodePayload({ ...validPayload(), version: 1 }), SCOPE)).toThrow(
      InvalidTranscriptCursorError,
    );
  });

  it('rejects an extra (unexpected) field', () => {
    expect(() =>
      decodeTranscriptCursor(encodePayload({ ...validPayload(), extra: 'nope' }), SCOPE),
    ).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects a missing field', () => {
    const payload = validPayload();
    delete payload.ordering;
    expect(() => decodeTranscriptCursor(encodePayload(payload), SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects wrong field types', () => {
    expect(() =>
      decodeTranscriptCursor(encodePayload({ ...validPayload(), turnSequence: 'x' }), SCOPE),
    ).toThrow(InvalidTranscriptCursorError);
    expect(() =>
      decodeTranscriptCursor(encodePayload({ ...validPayload(), ordering: 1.5 }), SCOPE),
    ).toThrow(InvalidTranscriptCursorError);
    expect(() =>
      decodeTranscriptCursor(encodePayload({ ...validPayload(), entityId: '' }), SCOPE),
    ).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects an unsafe integer (beyond 2^53)', () => {
    // 2^53 is not a safe integer; Number.isSafeInteger returns false.
    expect(() =>
      decodeTranscriptCursor(encodePayload({ ...validPayload(), turnSequence: 9007199254740992 }), SCOPE),
    ).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects an out-of-band kindRank', () => {
    expect(() =>
      decodeTranscriptCursor(encodePayload({ ...validPayload(), kindRank: 3 }), SCOPE),
    ).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects a turnSequence below the unbound floor (-1)', () => {
    expect(() =>
      decodeTranscriptCursor(encodePayload({ ...validPayload(), turnSequence: -2 }), SCOPE),
    ).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects a cursor minted for a different workspace', () => {
    const cursor = encodeTranscriptCursor({ workspaceId: 'other-ws', taskId: 'task-1' }, KEY);
    expect(() => decodeTranscriptCursor(cursor, SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects a cursor minted for a different task', () => {
    const cursor = encodeTranscriptCursor({ workspaceId: 'ws', taskId: 'other-task' }, KEY);
    expect(() => decodeTranscriptCursor(cursor, SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects an oversized cursor', () => {
    const huge = `v2.${'a'.repeat(5000)}`;
    expect(() => decodeTranscriptCursor(huge, SCOPE)).toThrow(InvalidTranscriptCursorError);
  });

  it('never echoes the raw cursor or content in the error', () => {
    const secret = encodePayload({ ...validPayload(), entityId: 'SUPER-SECRET-VALUE' });
    try {
      decodeTranscriptCursor(secret.replace('v2.', 'v9.'), SCOPE);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTranscriptCursorError);
      expect((error as Error).message).toBe('invalid transcript cursor');
      expect((error as Error).message).not.toContain('SUPER-SECRET-VALUE');
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
