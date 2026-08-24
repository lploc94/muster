/**
 * Shared image attachment validation and encoding.
 *
 * Used by host validation (src/host/send-request.ts) and the ACP run
 * pipeline (src/backends/acp-run.ts). Lives in src/shared/ rather than
 * src/host/ because backends/ importing from host/ would invert the
 * existing layering.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import * as path from 'node:path';

/** Per-attachment byte ceiling. Well under the 25 MiB dropped-file cap:
 * base64 inflates by 4/3 and the result travels inside one JSON-RPC message. */
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Extension (no dot, lowercase) -> IANA media type. Deliberately raster-only
 * formats vision models accept; SVG (markup, not raster) is excluded. */
export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** IANA media type for a supported image extension, or undefined otherwise. */
export function imageMimeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[ext];
}

/**
 * Last non-empty path segment of an attachment path, separator-agnostic.
 *
 * Deliberately not path.basename: attachment paths are absolute host paths
 * that may use either separator, and every transcript projector must yield the
 * same basename regardless of the platform running it (path.basename on POSIX
 * does not split a Windows path). Absolute paths must never reach the webview.
 *
 * Empty segments are discarded rather than taken as-is: a trailing separator
 * ("/tmp/drop/shot.png/") splits to a final "" and a naive last-segment read
 * would fall back to the whole input, leaking the absolute host path into the
 * transcript, the Markdown export, and the agent-visible omission notice.
 * statSync/readFileSync both accept such a path, so it never fails earlier.
 */
export function attachmentBasename(attachmentPath: string): string {
  const segments = attachmentPath.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i]) return segments[i];
  }
  return attachmentPath;
}


export type ReadImageAttachmentResult =
  | { ok: true; data: string; mimeType: string }
  | { ok: false; reason: string };

/**
 * Reads and base64-encodes an image file for an ACP prompt content block.
 * Never throws: unsupported extension, unreadable file, a non-regular file, or
 * an over-limit size all produce `{ ok: false }` rather than propagating an
 * exception, since a bad attachment should degrade the turn, not fail it.
 */
export function readImageAttachment(
  filePath: string,
  options?: { maxBytes?: number },
): ReadImageAttachmentResult {
  const mimeType = imageMimeForPath(filePath);
  if (!mimeType) {
    return { ok: false, reason: 'unsupported image type' };
  }

  const maxBytes = options?.maxBytes ?? IMAGE_ATTACHMENT_MAX_BYTES;

  // O_NONBLOCK keeps a FIFO/device open from hanging before fstat can classify
  // it; it is absent on Windows, where such paths are not openable this way.
  // Deliberately NOT O_NOFOLLOW (unlike hashUntrackedEntry in
  // src/task/source-revision.ts): a user may legitimately pick a symlinked
  // image, and every path reaching here was minted by the host, so refusing
  // symlinks would only break that case.
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | nonBlock);
  } catch {
    return { ok: false, reason: 'file not found' };
  }

  try {
    // Stat the DESCRIPTOR, not the path: the fd is pinned to the inode we
    // opened, so nothing swapped in at filePath between the check and the read
    // can redirect it. The size that clears the cap is the size we encode.
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      // Directory, FIFO, socket, or device wearing an image extension. Reading
      // a FIFO or character device would block the turn indefinitely.
      return { ok: false, reason: 'not a regular file' };
    }
    if (stat.size > maxBytes) {
      return { ok: false, reason: 'file too large' };
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    let filled = 0;
    while (filled < stat.size) {
      const chunk = readSync(fd, buffer, filled, stat.size - filled, filled);
      if (chunk <= 0) break;
      filled += chunk;
    }
    if (filled !== stat.size) {
      return { ok: false, reason: 'read failed' };
    }
    return { ok: true, data: buffer.toString('base64'), mimeType };
  } catch {
    return { ok: false, reason: 'read failed' };
  } finally {
    closeSync(fd);
  }
}
