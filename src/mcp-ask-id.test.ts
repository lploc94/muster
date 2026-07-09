import { describe, expect, it } from 'vitest';
// Import the pure sanitizer from the dev-only MCP ask server spike. The module
// guards its bootstrap behind an entrypoint check, so importing it here does not
// start the stdio transport or touch the filesystem.
// @ts-expect-error - plain .mjs dev spike without a type declaration
import { sanitizeAskId } from '../mcp/muster-ask-server.mjs';

describe('sanitizeAskId (mcp ask server path-traversal guard)', () => {
  it('accepts safe ids', () => {
    for (const id of ['ask-123', 'A_b.c-1', 'ask-1720000000000', 'x'.repeat(128)]) {
      expect(sanitizeAskId(id)).toBe(id);
    }
  });

  it('rejects path separators and traversal sequences', () => {
    const malicious = [
      '../../../home/user/.ssh/foo',
      '..',
      '.',
      'a/b',
      'a\\b',
      '/etc/passwd',
      'foo/../bar',
      'nul byte',
      'a\x00b',
      '',
      'x'.repeat(129),
    ];
    for (const id of malicious) {
      expect(() => sanitizeAskId(id)).toThrow(/Invalid ask id/);
    }
  });

  it('rejects non-string ids', () => {
    for (const id of [undefined, null, 42, {}, []] as unknown[]) {
      expect(() => sanitizeAskId(id)).toThrow(/Invalid ask id/);
    }
  });
});
