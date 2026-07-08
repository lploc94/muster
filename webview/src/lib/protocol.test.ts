import { describe, it, expect, vi } from 'vitest';

// protocol.ts transitively imports ./vscode, whose module body calls
// acquireVsCodeApi() (a webview-only global) at import time. Stub the module so
// the pure helpers under test can be imported in the node test environment.
// vi.mock is hoisted above the imports below, so it applies before protocol.ts
// (and thus ./vscode) is evaluated.
vi.mock('./vscode', () => ({
  vscode: { postMessage: () => {}, getState: () => undefined, setState: () => {} },
}));

import { PROTOCOL_VERSION, isProtocolCompatible, isExtMessage } from './protocol';

describe('PROTOCOL_VERSION', () => {
  it('is exported as a finite integer (single source of truth)', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number');
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });
});

describe('isProtocolCompatible', () => {
  it('treats the same version as compatible', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it('treats a newer peer version as incompatible', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it('treats an older peer version as incompatible', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION - 1)).toBe(false);
  });

  it('treats an absent version (old peer predating stamping) as incompatible', () => {
    expect(isProtocolCompatible(undefined)).toBe(false);
    expect(isProtocolCompatible(null)).toBe(false);
  });

  it('treats a non-numeric version as incompatible', () => {
    expect(isProtocolCompatible(String(PROTOCOL_VERSION))).toBe(false);
    expect(isProtocolCompatible({})).toBe(false);
    expect(isProtocolCompatible(NaN)).toBe(false);
  });
});

describe('isExtMessage snapshot version tolerance', () => {
  const baseSnapshot = { type: 'snapshot', rootTasks: [], storeRevision: 0 };

  it('accepts a snapshot stamped with the current protocolVersion', () => {
    expect(isExtMessage({ ...baseSnapshot, protocolVersion: PROTOCOL_VERSION })).toBe(true);
  });

  it('accepts a snapshot without a protocolVersion (backward-tolerant shape)', () => {
    // The compatibility decision lives in isProtocolCompatible; the shape guard
    // itself stays tolerant so an unstamped snapshot is still recognized as one.
    expect(isExtMessage(baseSnapshot)).toBe(true);
  });

  it('rejects a snapshot whose protocolVersion is not a number', () => {
    expect(isExtMessage({ ...baseSnapshot, protocolVersion: 'nope' })).toBe(false);
  });
});
