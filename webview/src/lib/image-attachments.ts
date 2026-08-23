/**
 * Webview-side image attachment helpers.
 *
 * Duplicated from src/shared/image-attachments.ts rather than imported: the
 * webview builds through its own Vite root at webview/ and does not share a
 * module graph with the extension host's src/.
 */

/** Keep in sync with IMAGE_MIME_BY_EXTENSION in src/shared/image-attachments.ts. */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Whether a path's extension is a supported raster image format. */
export function isImagePath(value: string): boolean {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = value.slice(dot + 1).toLowerCase();
  return ext in MIME_BY_EXTENSION;
}

/** File extension (no dot) for a pasted image's MIME type, or undefined. */
export function imageExtensionForMime(mime: string): string | undefined {
  return EXTENSION_BY_MIME[mime];
}
