/** Backends the webview composer may persist as the default for new tasks. */
export const COMPOSER_BACKEND_IDS = ['claude', 'grok', 'kiro', 'codex', 'opencode'] as const;

export type ComposerBackendId = (typeof COMPOSER_BACKEND_IDS)[number];

export interface ComposerSelection {
  backend: ComposerBackendId;
  /** null / omitted = backend default model. */
  model: string | null;
}

/** `globalState` key for the last-used composer backend/model preference. */
export const COMPOSER_SELECTION_STATE_KEY = 'muster.composerSelection';

export function isComposerBackendId(value: unknown): value is ComposerBackendId {
  return (
    value === 'claude' ||
    value === 'grok' ||
    value === 'kiro' ||
    value === 'codex' ||
    value === 'opencode'
  );
}

/**
 * Normalize a raw globalState / inbound payload into a composer selection.
 * Returns null when the payload is missing or not a known backend.
 */
export function parseComposerSelection(raw: unknown): ComposerSelection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as { backend?: unknown; model?: unknown };
  if (!isComposerBackendId(record.backend)) return null;
  const model =
    typeof record.model === 'string' && record.model.length > 0 ? record.model : null;
  return { backend: record.backend, model };
}

export interface ComposerSelectionStore {
  get(key: string): unknown;
  update(key: string, value: ComposerSelection): Thenable<void> | PromiseLike<void> | void;
}

/** Read the last-used composer selection from host globalState (best-effort). */
export function readComposerSelection(store: ComposerSelectionStore): ComposerSelection | null {
  try {
    return parseComposerSelection(store.get(COMPOSER_SELECTION_STATE_KEY));
  } catch {
    return null;
  }
}

/** Persist the last-used composer selection to host globalState (best-effort). */
export async function writeComposerSelection(
  store: ComposerSelectionStore,
  selection: ComposerSelection,
): Promise<void> {
  try {
    await store.update(COMPOSER_SELECTION_STATE_KEY, {
      backend: selection.backend,
      model: selection.model,
    });
  } catch {
    // best-effort — preference is UX only
  }
}
