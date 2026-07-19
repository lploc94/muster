import { describe, expect, it } from 'vitest';
import { NODE_SQLITE_MISSING_MESSAGE, probeNodeSqlite } from './probe';

describe('probeNodeSqlite', () => {
  it('reports available in this runtime (Node 22+ / node:sqlite present)', () => {
    const result = probeNodeSqlite();
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails loudly with an upgrade message when the module is missing', () => {
    const result = probeNodeSqlite(() => {
      throw new Error("Cannot find module 'node:sqlite'");
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe(NODE_SQLITE_MISSING_MESSAGE);
  });

  it('fails when the module lacks DatabaseSync (never falls back silently)', () => {
    const result = probeNodeSqlite(() => ({}));
    expect(result.available).toBe(false);
    expect(result.reason).toBe(NODE_SQLITE_MISSING_MESSAGE);
  });
});
