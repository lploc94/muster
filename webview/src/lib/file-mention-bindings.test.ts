import { describe, expect, it } from 'vitest';
import {
  allocateDisplayToken,
  displayNameForPath,
  expandMentionsForLlm,
  mentionTokenFor,
} from './file-mention-bindings';

describe('mentionTokenFor / displayNameForPath', () => {
  it('quotes names with spaces', () => {
    expect(mentionTokenFor('Ảnh màn hình.png')).toBe('@"Ảnh màn hình.png"');
    expect(mentionTokenFor('src/a.ts')).toBe('@src/a.ts');
  });

  it('takes basename for display', () => {
    expect(displayNameForPath('/var/folders/x/T/muster-file-drops/1-logo.png')).toBe('1-logo.png');
    expect(displayNameForPath('src/host/a.ts')).toBe('a.ts');
  });
});

describe('allocateDisplayToken + expandMentionsForLlm', () => {
  it('binds display name and expands to full path on send', () => {
    const bindings = new Map<string, string>();
    const abs = '/var/folders/x/T/muster-file-drops/1-Ảnh màn hình.png';
    const { token } = allocateDisplayToken(bindings, abs, 'Ảnh màn hình.png');
    expect(token).toBe('@"Ảnh màn hình.png"');

    const draft = `Xem ${token} giúp tôi`;
    expect(expandMentionsForLlm(draft, bindings)).toBe(
      `Xem @"/var/folders/x/T/muster-file-drops/1-Ảnh màn hình.png" giúp tôi`,
    );
  });

  it('disambiguates duplicate basenames', () => {
    const bindings = new Map<string, string>();
    const a = allocateDisplayToken(bindings, '/tmp/a/logo.png', 'logo.png');
    const b = allocateDisplayToken(bindings, '/tmp/b/logo.png', 'logo.png');
    expect(a.token).toBe('@logo.png');
    // Space in disambiguated name → quoted token
    expect(b.token).toBe('@"logo (2).png"');
    expect(
      expandMentionsForLlm(`compare ${a.token} and ${b.token}`, bindings),
    ).toBe('compare @/tmp/a/logo.png and @/tmp/b/logo.png');
  });

  it('leaves unbound mentions unchanged', () => {
    const bindings = new Map<string, string>();
    allocateDisplayToken(bindings, '/tmp/x.ts', 'x.ts');
    expect(expandMentionsForLlm('see @y.ts and @x.ts', bindings)).toBe('see @y.ts and @/tmp/x.ts');
  });

  it('does not expand a bound token that is only a prefix of a longer mention', () => {
    const bindings = new Map<string, string>();
    allocateDisplayToken(bindings, '/tmp/x.ts', 'x.ts');
    expect(expandMentionsForLlm('see @x.ts.backup', bindings)).toBe('see @x.ts.backup');
  });

  it('escapes quotes inside display names', () => {
    expect(mentionTokenFor('a "draft".md')).toBe('@"a \\"draft\\".md"');
  });

  it('quotes Unicode and punctuation so chips still highlight', () => {
    expect(mentionTokenFor('Ảnh màn hình.png')).toBe('@"Ảnh màn hình.png"');
    expect(mentionTokenFor('file(1).ts')).toBe('@"file(1).ts"');
    expect(mentionTokenFor('src/a.ts')).toBe('@src/a.ts');
  });
});
