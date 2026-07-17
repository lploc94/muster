/**
 * Opaque, versioned, self-contained transcript cursor (P4-W3).
 *
 * A cursor encodes the full canonical sort key of the OLDEST item on a page so the
 * next (older) page can be selected by a pure keyset predicate — no anchor entity
 * needs to still exist, and no server-side offset is kept. This is deliberately NOT
 * backward compatible with the Phase-3 `v1.` string key: there is one cursor format.
 *
 * Encoding: `v2.<base64url(JSON payload)>`. The payload carries workspace/task scope
 * so a cursor minted for one task can never silently page another.
 */
import { CANONICAL_KIND_RANKS, UNBOUND_TURN_SEQUENCE } from './transcript-order';
import type { TranscriptSortKey } from './transcript-order';

/** Current (only) cursor version. */
const CURSOR_VERSION = 2;
const CURSOR_PREFIX = 'v2.';
/** Generous cap: a valid payload is well under this. Rejects hostile/oversized input. */
const MAX_CURSOR_LENGTH = 4096;

/** Self-contained cursor payload (see module docstring). */
export interface TranscriptCursorPayload {
  version: 2;
  workspaceId: string;
  taskId: string;
  turnSequence: number;
  kindRank: number;
  ordering: number;
  createdAt: string;
  entityId: string;
}

/** Scope a cursor must belong to. Mismatch is rejected — never silently ignored. */
export interface TranscriptCursorScope {
  workspaceId: string;
  taskId: string;
}

/**
 * Stable, typed error for every cursor rejection. The message is intentionally
 * generic: it never embeds the raw cursor text or any user/transcript content, so
 * logs cannot leak it (plan §3.4 / §2).
 */
export class InvalidTranscriptCursorError extends Error {
  constructor() {
    super('invalid transcript cursor');
    this.name = 'InvalidTranscriptCursorError';
  }
}

/** Encode the sort key of the oldest item on a page into an opaque cursor. */
export function encodeTranscriptCursor(scope: TranscriptCursorScope, key: TranscriptSortKey): string {
  const payload: TranscriptCursorPayload = {
    version: CURSOR_VERSION,
    workspaceId: scope.workspaceId,
    taskId: scope.taskId,
    turnSequence: key.turnSequence,
    kindRank: key.kindRank,
    ordering: key.ordering,
    createdAt: key.createdAt,
    entityId: key.entityId,
  };
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Exact set of payload keys a valid v2 cursor carries — no more, no fewer. */
const EXPECTED_PAYLOAD_KEYS = [
  'createdAt',
  'entityId',
  'kindRank',
  'ordering',
  'taskId',
  'turnSequence',
  'version',
  'workspaceId',
].join(',');

/** Strict UTF-8 decoder: throws on invalid byte sequences instead of emitting U+FFFD. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode and fully validate a cursor against the expected scope. Throws
 * {@link InvalidTranscriptCursorError} for any structural, version, or scope
 * failure. On success returns the sort key to feed the keyset predicate.
 */
export function decodeTranscriptCursor(cursor: string, scope: TranscriptCursorScope): TranscriptSortKey {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new InvalidTranscriptCursorError();
  }
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new InvalidTranscriptCursorError();
  }
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  // Reject non-canonical base64url: only the base64url alphabet, no padding.
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new InvalidTranscriptCursorError();
  }

  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    // Round-trip: reject alternate trailing base64 bits / any non-canonical encoding
    // that decodes to the same bytes but is not the byte string's canonical form.
    if (bytes.toString('base64url') !== encoded) {
      throw new InvalidTranscriptCursorError();
    }
    // Strict UTF-8: reject invalid byte sequences instead of silently yielding U+FFFD.
    const json = strictUtf8.decode(bytes);
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidTranscriptCursorError();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidTranscriptCursorError();
  }
  const payload = parsed as Record<string, unknown>;
  // Exact key set: reject any missing or extra field (no unexpected properties).
  if (Object.keys(payload).sort().join(',') !== EXPECTED_PAYLOAD_KEYS) {
    throw new InvalidTranscriptCursorError();
  }
  if (
    payload.version !== CURSOR_VERSION ||
    !nonEmptyString(payload.workspaceId) ||
    !nonEmptyString(payload.taskId) ||
    !isSafeInteger(payload.turnSequence) ||
    !isSafeInteger(payload.kindRank) ||
    !isSafeInteger(payload.ordering) ||
    !nonEmptyString(payload.createdAt) ||
    !nonEmptyString(payload.entityId)
  ) {
    throw new InvalidTranscriptCursorError();
  }

  // Domain bounds: turnSequence >= -1 (unbound sentinel floor); kindRank must be a
  // real canonical rank. Out-of-band integers cannot describe a real transcript row.
  if (payload.turnSequence < UNBOUND_TURN_SEQUENCE || !CANONICAL_KIND_RANKS.has(payload.kindRank)) {
    throw new InvalidTranscriptCursorError();
  }

  // Scope binding: a cursor may only page the workspace/task it was minted for.
  if (payload.workspaceId !== scope.workspaceId || payload.taskId !== scope.taskId) {
    throw new InvalidTranscriptCursorError();
  }

  return {
    turnSequence: payload.turnSequence,
    kindRank: payload.kindRank,
    ordering: payload.ordering,
    createdAt: payload.createdAt,
    entityId: payload.entityId,
  };
}
