import {
  BACKEND_READINESS_IDS,
  isBackendReadinessId,
  type BackendReadinessId,
} from '../../../src/shared/backend-readiness';

/** Backends selectable from the webview toolbar (shared allowlist). */
export type WebviewBackendId = BackendReadinessId;

/** Re-export ordered allowlist so webview consumers do not fork IDs. */
export const WEBVIEW_BACKEND_IDS = BACKEND_READINESS_IDS;

/** Parse a bare backend id or a model-picker value `backend::model`. */
export function parseBackendId(raw: string | undefined | null): WebviewBackendId | null {
  if (!raw) return null;
  const sep = raw.indexOf('::');
  const backend = sep >= 0 ? raw.slice(0, sep) : raw;
  return isBackendReadinessId(backend) ? backend : null;
}

/** Model segment from `backend::model`, or null for bare backend / empty. */
export function parseModelFromSelectValue(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const sep = raw.indexOf('::');
  if (sep < 0) return null;
  const model = raw.slice(sep + 2);
  return model.length > 0 ? model : null;
}
