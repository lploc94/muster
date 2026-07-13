/** Backends selectable from the webview toolbar. */
export type WebviewBackendId = 'claude' | 'grok' | 'kiro' | 'codex' | 'opencode';

const BACKEND_IDS: readonly WebviewBackendId[] = [
  'claude',
  'grok',
  'kiro',
  'codex',
  'opencode',
];

/** Parse a bare backend id or a model-picker value `backend::model`. */
export function parseBackendId(raw: string | undefined | null): WebviewBackendId | null {
  if (!raw) return null;
  const sep = raw.indexOf('::');
  const backend = sep >= 0 ? raw.slice(0, sep) : raw;
  return (BACKEND_IDS as readonly string[]).includes(backend)
    ? (backend as WebviewBackendId)
    : null;
}

/** Model segment from `backend::model`, or null for bare backend / empty. */
export function parseModelFromSelectValue(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const sep = raw.indexOf('::');
  if (sep < 0) return null;
  const model = raw.slice(sep + 2);
  return model.length > 0 ? model : null;
}
