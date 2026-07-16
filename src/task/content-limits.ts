export const TASK_RESULT_MAX_BYTES = 16_384;
export const TASK_ERROR_MAX_BYTES = 4_096;
export const TRUNCATED_CONTENT_MARKER = '\n… [truncated]';

export interface Utf8TruncationResult {
  text: string;
  truncated: boolean;
}

/** Clamp without splitting a Unicode code point; max is always measured in UTF-8 bytes. */
export function truncateUtf8Bytes(
  value: string,
  maxBytes: number,
  marker = TRUNCATED_CONTENT_MARKER,
): Utf8TruncationResult {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { text: value, truncated: false };
  }
  if (maxBytes <= 0) return { text: '', truncated: true };
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const markerFits = markerBytes <= maxBytes;
  const usableBytes = markerFits ? maxBytes - markerBytes : maxBytes;
  let bytes = 0;
  let text = '';
  for (const point of value) {
    const pointBytes = Buffer.byteLength(point, 'utf8');
    if (bytes + pointBytes > usableBytes) break;
    text += point;
    bytes += pointBytes;
  }
  const suffix = markerFits ? marker : '';
  return { text: text + suffix, truncated: true };
}
