/**
 * Canonical transcript ordering contract (sqlite-global-storage-refactor P4-W3).
 *
 * A transcript item's position is fully determined by the 5-tuple sort key
 * `(turnSequence, kindRank, ordering, createdAt, entityId)`, compared
 * lexicographically ascending. This single contract is shared by three sites that
 * MUST agree, or paging drifts:
 *
 *   1. `buildTranscript()` (src/host/snapshot.ts) — the in-memory projector.
 *   2. The SQLite keyset query (src/task/repository.ts `getTranscriptPage`).
 *   3. The opaque cursor (src/task/transcript-cursor.ts).
 *
 * `kindRank` is its own axis between `turnSequence` and `ordering` so reasoning,
 * assistant messages, and tool calls (same rank) interleave by their shared
 * per-turn `ordering` counter, while user prompts sort ahead of the response stream.
 *
 * Every component is non-null after normalization: unbound items use
 * `UNBOUND_TURN_SEQUENCE`, and message `ordering` falls back per role.
 */

/** Kind rank: the second sort axis. Lower sorts earlier within a turn. */
export const KIND_RANK = {
  user: 0,
  reasoning: 1,
  assistant: 1,
  tool: 1,
} as const;

/**
 * The complete set of legal `kindRank` values (derived from {@link KIND_RANK}).
 * Cursor validation rejects any rank outside this set — a decoded cursor must map
 * to a real kind axis, never an out-of-band integer.
 */
export const CANONICAL_KIND_RANKS: ReadonlySet<number> = new Set(Object.values(KIND_RANK));

/** `ordering` fallback for a user message with no explicit `order` (opening prompt). */
export const USER_ORDERING_FALLBACK = -2;
/** `ordering` fallback for an assistant message with no explicit `order`. */
export const ASSISTANT_ORDERING_FALLBACK = 0;
/** `turnSequence` for an item that cannot be bound to a turn. Sorts before all turns. */
export const UNBOUND_TURN_SEQUENCE = -1;

/** The canonical transcript sort key. All fields non-null after normalization. */
export interface TranscriptSortKey {
  turnSequence: number;
  kindRank: number;
  ordering: number;
  createdAt: string;
  entityId: string;
}

/**
 * Byte-for-byte comparison of two strings by their UTF-8 encoding. This is exactly
 * SQLite's default `BINARY` collation (a `memcmp` over the encoded bytes), so it is
 * locale- and machine-independent — unlike `String.prototype.localeCompare`, whose
 * result depends on the host ICU/locale. Returns <0, 0, or >0.
 */
export function compareBinary(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Compare two canonical sort keys. Returns <0 if `a` sorts before `b`, >0 if after,
 * 0 if identical. Ascending order matches render order (oldest → newest). String
 * fields (`createdAt`, `entityId`) are compared bytewise over their UTF-8 encoding
 * via {@link compareBinary}, matching the SQLite default `BINARY` collation used by
 * the keyset query's `ORDER BY` and `<` tuple predicate. This keeps the in-memory
 * projector, the SQL page, and the cursor in exact agreement on every platform.
 */
export function compareTranscriptKeys(a: TranscriptSortKey, b: TranscriptSortKey): number {
  return (
    a.turnSequence - b.turnSequence ||
    a.kindRank - b.kindRank ||
    a.ordering - b.ordering ||
    compareBinary(a.createdAt, b.createdAt) ||
    compareBinary(a.entityId, b.entityId)
  );
}
