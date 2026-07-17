/** Bound and scrub handoff failure text before it reaches task/UI projections. */
export function sanitizeHandoffFailureMessage(message: string): string {
  let text = message
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[path]')
    .replace(/(?:^|[\s"'`(=])(\/(?:[^\s"'`)]+\/)+[^\s"'`)]+)/g, (match, pathPart: string) =>
      match.replace(pathPart, '[path]'),
    )
    .replace(/\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
    .replace(
      /\b((?:password|passwd|pwd|passphrase|api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret|token|auth[_-]?token|private[_-]?key|aws_secret_access_key|aws_access_key_id)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:sk|pk|api[_-]?key|token|secret|key)[-_][A-Za-z0-9][-_A-Za-z0-9]{4,}\b/gi, '[redacted]')
    .replace(/([A-Za-z0-9])\1{20,}/g, '$1$1$1…');
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}
