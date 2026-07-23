/** Approximately 64k tokens for ordinary UTF-8/English prompt content. */
export const TASK_MESSAGE_MAX_CHARS = 262_144;
export const TASK_RESULT_MAX_BYTES = 262_144;
export const TASK_ERROR_MAX_BYTES = 16_384;
export const WORKFLOW_FEEDBACK_MAX_BYTES = 65_536;
export const PRESENTATION_MARKDOWN_MAX_CHARS = 1_048_576;
export const MCP_JSON_BODY_MAX_BYTES = 8_388_608;
export const SQLITE_WORKFLOW_ENVELOPE_MAX_BYTES = 16_777_216;
export const TRUNCATED_CONTENT_MARKER = '\n… [truncated]';

export interface Utf8TruncationResult {
  text: string;
  truncated: boolean;
}

export function fitsUtf8Bytes(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxBytes;
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
