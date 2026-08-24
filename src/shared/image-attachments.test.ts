import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMAGE_EXTENSIONS,
  imageExtensionForMime,
  isImagePath,
} from '../../webview/src/lib/image-attachments';
import {
  attachmentBasename,
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_MIME_BY_EXTENSION,
  imageMimeForPath,
  readImageAttachment,
} from './image-attachments';

describe('imageMimeForPath', () => {
  it('resolves every supported extension case-insensitively', () => {
    expect(imageMimeForPath('shot.png')).toBe('image/png');
    expect(imageMimeForPath('SHOT.PNG')).toBe('image/png');
    expect(imageMimeForPath('a.jpg')).toBe('image/jpeg');
    expect(imageMimeForPath('a.jpeg')).toBe('image/jpeg');
    expect(imageMimeForPath('a.gif')).toBe('image/gif');
    expect(imageMimeForPath('a.webp')).toBe('image/webp');
  });

  it('returns undefined for unsupported or missing extensions', () => {
    expect(imageMimeForPath('doc.txt')).toBeUndefined();
    expect(imageMimeForPath('noext')).toBeUndefined();
    expect(imageMimeForPath('image.svg')).toBeUndefined();
  });

  it('matches the exported extension-to-mime map', () => {
    for (const [ext, mime] of Object.entries(IMAGE_MIME_BY_EXTENSION)) {
      expect(imageMimeForPath(`file.${ext}`)).toBe(mime);
    }
  });
});

describe('attachmentBasename', () => {
  it('reduces both separator styles regardless of host platform', () => {
    expect(attachmentBasename('/tmp/muster-drop-x/shot.png')).toBe('shot.png');
    expect(attachmentBasename('C:\\Users\\dev\\AppData\\Local\\Temp\\shot.png')).toBe('shot.png');
    expect(attachmentBasename('shot.png')).toBe('shot.png');
  });

  it('never falls back to the absolute path when a separator trails', () => {
    // A trailing separator makes the final split segment empty. Returning the
    // whole input there would leak the absolute host path (and the OS username)
    // into the transcript, the Markdown export, and the omission notice.
    // statSync/readFileSync both accept such a path, and imageMimeForPath still
    // resolves .png, so nothing upstream rejects it first.
    expect(attachmentBasename('/tmp/muster-drop-x/shot.png/')).toBe('shot.png');
    expect(attachmentBasename('C:\\Users\\dev\\shot.png\\')).toBe('shot.png');
    expect(attachmentBasename('/tmp/x/shot.png///')).toBe('shot.png');
  });

  it('returns the input only when it holds no non-empty segment', () => {
    expect(attachmentBasename('/')).toBe('/');
    expect(attachmentBasename('')).toBe('');
  });
});

describe('readImageAttachment', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads and base64-encodes a supported image file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'muster-image-test-'));
    const file = path.join(dir, 'shot.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeFileSync(file, bytes);

    const result = readImageAttachment(file);

    expect(result).toEqual({ ok: true, data: bytes.toString('base64'), mimeType: 'image/png' });
  });

  it('rejects an unsupported extension without touching the filesystem', () => {
    const result = readImageAttachment('/does/not/exist.txt');
    expect(result).toEqual({ ok: false, reason: 'unsupported image type' });
  });

  it('rejects a missing file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'muster-image-test-'));
    const missing = path.join(dir, 'ghost.png');
    expect(readImageAttachment(missing)).toEqual({ ok: false, reason: 'file not found' });
  });

  it('rejects a file over the byte cap without reading its contents', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'muster-image-test-'));
    const file = path.join(dir, 'big.png');
    writeFileSync(file, Buffer.alloc(1024));

    const result = readImageAttachment(file, { maxBytes: 512 });

    expect(result).toEqual({ ok: false, reason: 'file too large' });
  });

  it('uses the exported default cap when no override is given', () => {
    expect(IMAGE_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('accepts a file sitting exactly on the byte cap', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'muster-image-test-'));
    const file = path.join(dir, 'exact.png');
    const bytes = Buffer.alloc(512, 7);
    writeFileSync(file, bytes);

    // The cap is inclusive: `size > maxBytes` rejects. Flipping that to `>=`
    // would silently refuse legitimate cap-sized images, so pin the boundary.
    expect(readImageAttachment(file, { maxBytes: 512 })).toEqual({
      ok: true,
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    });
    expect(readImageAttachment(file, { maxBytes: 511 })).toEqual({
      ok: false,
      reason: 'file too large',
    });
  });

  it('rejects a non-regular file wearing an image extension', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'muster-image-test-'));
    // A directory is the portable stand-in for the whole non-regular class
    // (FIFO, socket, device). Reading a FIFO would block the turn forever, so
    // the fd must be classified by fstat before any read is attempted.
    const asDirectory = path.join(dir, 'trap.png');
    mkdirSync(asDirectory);

    expect(readImageAttachment(asDirectory)).toEqual({
      ok: false,
      reason: 'not a regular file',
    });
  });
});

/**
 * webview/src/lib/image-attachments.ts deliberately duplicates this module's
 * extension knowledge: the webview builds through its own Vite root and cannot
 * import a module that pulls in node:fs. The pin lives here, on the host side,
 * because only this direction typechecks — the webview tsconfig has no node
 * types. Without it, adding a format on one side only ships silently: the
 * picker offers a file the prompt pipeline then refuses.
 */
describe('webview image attachment tables track this module', () => {
  it('offers exactly the extensions the host accepts', () => {
    expect([...IMAGE_EXTENSIONS].sort()).toEqual(Object.keys(IMAGE_MIME_BY_EXTENSION).sort());
  });

  it('classifies every host-supported extension as an image path', () => {
    for (const ext of Object.keys(IMAGE_MIME_BY_EXTENSION)) {
      expect(isImagePath(`shot.${ext}`)).toBe(true);
      expect(isImagePath(`SHOT.${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it('round-trips every host MIME type through a pasted-image extension', () => {
    for (const mime of Object.values(IMAGE_MIME_BY_EXTENSION)) {
      const ext = imageExtensionForMime(mime);
      expect(ext, `no pasted-image extension for ${mime}`).toBeDefined();
      // The suffix chosen for a pasted image must map back to the same MIME
      // type, or paste stages a file the send pipeline then rejects.
      expect(imageMimeForPath(`pasted.${ext}`)).toBe(mime);
    }
  });

  it('rejects unsupported and extensionless paths on both sides, including SVG', () => {
    // SVG is markup, not raster: excluded on both sides on purpose.
    for (const bad of ['diagram.svg', 'notes.txt', 'noext']) {
      expect(isImagePath(bad)).toBe(false);
      expect(imageMimeForPath(bad)).toBeUndefined();
    }
    expect(imageExtensionForMime('image/svg+xml')).toBeUndefined();
  });
});
