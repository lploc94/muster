import { describe, expect, it } from 'vitest';
import { ImagePathAuthorizations } from './image-authorizations';

describe('ImagePathAuthorizations', () => {
  it('accepts only paths minted by the host', () => {
    const authorizations = new ImagePathAuthorizations();
    authorizations.authorize('C:\\Pictures\\shot.png');

    expect(authorizations.authorizedAll(['C:\\Pictures\\shot.png'])).toBe(true);
    expect(authorizations.authorizedAll(['C:\\Pictures\\other.png'])).toBe(false);
    expect(authorizations.authorizedAll([])).toBe(true);
    expect(authorizations.authorizedAll(undefined)).toBe(true);
  });

  it('evicts the oldest path at the configured bound', () => {
    const authorizations = new ImagePathAuthorizations(2);
    authorizations.authorize('one.png');
    authorizations.authorize('two.png');
    authorizations.authorize('three.png');

    expect(authorizations.size).toBe(2);
    expect(authorizations.authorizedAll(['one.png'])).toBe(false);
    expect(authorizations.authorizedAll(['two.png', 'three.png'])).toBe(true);
  });

  it('refreshes recency when a path is minted again', () => {
    const authorizations = new ImagePathAuthorizations(2);
    authorizations.authorize('one.png');
    authorizations.authorize('two.png');
    authorizations.authorize('one.png');
    authorizations.authorize('three.png');

    expect(authorizations.authorizedAll(['one.png', 'three.png'])).toBe(true);
    expect(authorizations.authorizedAll(['two.png'])).toBe(false);
  });
});
