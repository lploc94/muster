/** Backends the webview composer may persist as the default for new tasks. */
export const COMPOSER_BACKEND_IDS = ['claude', 'grok', 'kiro', 'codex', 'opencode'] as const;

export type ComposerBackendId = (typeof COMPOSER_BACKEND_IDS)[number];

export interface ComposerSelection {
  backend: ComposerBackendId;
  /** null / omitted = backend default model. */
  model: string | null;
}

/**
 * VS Code configuration key for the durable composer backend/model preference.
 * Stored as one validated object (not separate keys) so updates stay atomic.
 */
export const COMPOSER_SELECTION_CONFIG_KEY = 'muster.composerSelection';

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
 * Normalize a raw Settings / inbound payload into a composer selection.
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

export interface ComposerSelectionConfig {
  get(section: string): unknown;
  update(
    section: string,
    value: ComposerSelection,
    target: unknown,
  ): Thenable<void> | PromiseLike<void> | void;
}

/** Read durable composer selection from VS Code Settings (best-effort). */
export function readComposerSelection(config: ComposerSelectionConfig): ComposerSelection | null {
  try {
    return parseComposerSelection(config.get(COMPOSER_SELECTION_CONFIG_KEY));
  } catch {
    return null;
  }
}

/** Persist composer selection to ConfigurationTarget.Global (best-effort). */
export async function writeComposerSelection(
  config: ComposerSelectionConfig,
  selection: ComposerSelection,
  globalTarget: unknown,
): Promise<void> {
  try {
    await config.update(
      COMPOSER_SELECTION_CONFIG_KEY,
      {
        backend: selection.backend,
        model: selection.model,
      },
      globalTarget,
    );
  } catch {
    // best-effort — preference is UX only
  }
}
