import { createHash } from 'crypto';
import {
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from '../task/coordinator-tools';

const RESTORE_KEYS = new Set([
  'rootId',
  'presentationId',
  'ownerTaskId',
  'revision',
  'title',
  'markdown',
]);
const REQUEST_KEYS = new Set([
  'presentationId',
  'ownerTaskId',
  'opId',
  'revision',
  'title',
  'markdown',
]);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface PresentationContext {
  rootId: string;
  callerTaskId: string;
  turnId: string;
}

export interface PresentationUpsertRequest {
  presentationId: string;
  ownerTaskId: string;
  opId: string;
  revision: number;
  title: string;
  markdown: string;
}

export interface PresentationDocument {
  presentationId: string;
  ownerTaskId: string;
  revision: number;
  title: string;
  markdown: string;
}

export interface PresentationPanel {
  update(document: PresentationDocument): Promise<boolean>;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
}

export interface PresentationPanelFactory {
  create(document: PresentationDocument): PresentationPanel;
}

export function configurePresentationPanel<T extends { dispose(): void }, R>(
  panel: T,
  configure: () => R,
): R {
  try {
    return configure();
  } catch (error) {
    try {
      panel.dispose();
    } catch {
      // Preserve the original configuration failure for the manager boundary.
    }
    throw error;
  }
}

export interface PersistedPresentationDocument extends PresentationDocument {
  rootId: string;
}

export type PresentationResult =
  | { ok: true; code: 'opened' | 'idempotent' | 'restored' }
  | {
      ok: false;
      code:
        | 'invalid_arguments'
        | 'owner_mismatch'
        | 'op_conflict'
        | 'stale_revision'
        | 'payload_too_large'
        | 'restore_rejected'
        | 'restore_conflict'
        | 'host_delivery_failed'
        | 'panel_open_failed';
    };

function isStableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PRESENTATION_ID_MAX_LENGTH &&
    STABLE_ID_PATTERN.test(value)
  );
}

function validatePersistedDocument(value: unknown): value is PersistedPresentationDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).length === RESTORE_KEYS.size &&
    Object.keys(state).every((key) => RESTORE_KEYS.has(key)) &&
    isStableId(state.rootId) &&
    isStableId(state.presentationId) &&
    isStableId(state.ownerTaskId) &&
    Number.isSafeInteger(state.revision) &&
    (state.revision as number) > 0 &&
    typeof state.title === 'string' &&
    state.title.length > 0 &&
    state.title.length <= PRESENTATION_TITLE_MAX_LENGTH &&
    typeof state.markdown === 'string' &&
    state.markdown.length > 0 &&
    state.markdown.length <= PRESENTATION_MARKDOWN_MAX_LENGTH
  );
}

function documentFingerprint(document: PresentationDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function validateRequest(request: PresentationUpsertRequest): PresentationResult | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, code: 'invalid_arguments' };
  }
  if (
    (typeof request.presentationId === 'string' &&
      request.presentationId.length > PRESENTATION_ID_MAX_LENGTH) ||
    (typeof request.ownerTaskId === 'string' &&
      request.ownerTaskId.length > PRESENTATION_ID_MAX_LENGTH) ||
    (typeof request.opId === 'string' && request.opId.length > PRESENTATION_ID_MAX_LENGTH) ||
    (typeof request.title === 'string' && request.title.length > PRESENTATION_TITLE_MAX_LENGTH) ||
    (typeof request.markdown === 'string' &&
      request.markdown.length > PRESENTATION_MARKDOWN_MAX_LENGTH)
  ) {
    return { ok: false, code: 'payload_too_large' };
  }
  if (
    Object.keys(request).some((key) => !REQUEST_KEYS.has(key)) ||
    !isStableId(request.presentationId) ||
    !isStableId(request.ownerTaskId) ||
    !isStableId(request.opId) ||
    !Number.isSafeInteger(request.revision) ||
    request.revision <= 0 ||
    typeof request.title !== 'string' ||
    request.title.length === 0 ||
    typeof request.markdown !== 'string' ||
    request.markdown.length === 0
  ) {
    return { ok: false, code: 'invalid_arguments' };
  }
  return undefined;
}

interface PanelEntry {
  panel: PresentationPanel;
  disposeListener: { dispose(): void };
  document: PresentationDocument;
}

export class PresentationManager {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly operations = new Map<string, string>();

  constructor(private readonly factory: PresentationPanelFactory) {}

  /**
   * User-initiated open (e.g. click a workspace `.md` link in chat).
   * Bypasses credential/opId gates; reuses the panel for the same presentationId
   * under `rootId`, bumps revision when content changes, otherwise reveals.
   */
  async openWorkspaceDocument(
    rootId: string,
    document: Omit<PresentationDocument, 'revision'> & { revision?: number },
  ): Promise<PresentationResult> {
    if (!isStableId(rootId) || !isStableId(document.presentationId) || !isStableId(document.ownerTaskId)) {
      return { ok: false, code: 'invalid_arguments' };
    }
    if (
      typeof document.title !== 'string' ||
      document.title.length === 0 ||
      document.title.length > PRESENTATION_TITLE_MAX_LENGTH ||
      typeof document.markdown !== 'string' ||
      document.markdown.length === 0 ||
      document.markdown.length > PRESENTATION_MARKDOWN_MAX_LENGTH
    ) {
      return { ok: false, code: 'invalid_arguments' };
    }

    const key = this.presentationKey(rootId, document.presentationId);
    const existing = this.panels.get(key);
    if (existing) {
      const sameContent =
        existing.document.title === document.title &&
        existing.document.markdown === document.markdown &&
        existing.document.ownerTaskId === document.ownerTaskId;
      if (sameContent) {
        try {
          existing.panel.reveal();
        } catch {
          // best-effort focus
        }
        return { ok: true, code: 'idempotent' };
      }
      const next: PresentationDocument = {
        presentationId: document.presentationId,
        ownerTaskId: document.ownerTaskId,
        revision: existing.document.revision + 1,
        title: document.title,
        markdown: document.markdown,
      };
      let accepted = false;
      try {
        accepted = await existing.panel.update(next);
      } catch {
        // content-free failure
      }
      if (!accepted || this.panels.get(key) !== existing) {
        return { ok: false, code: 'host_delivery_failed' };
      }
      existing.document = next;
      try {
        existing.panel.reveal();
      } catch {
        // best-effort
      }
      return { ok: true, code: 'opened' };
    }

    const created: PresentationDocument = {
      presentationId: document.presentationId,
      ownerTaskId: document.ownerTaskId,
      revision: document.revision && document.revision > 0 ? document.revision : 1,
      title: document.title,
      markdown: document.markdown,
    };
    let panel: PresentationPanel;
    try {
      panel = this.factory.create(created);
    } catch {
      return { ok: false, code: 'panel_open_failed' };
    }
    let disposeListener: { dispose(): void };
    try {
      disposeListener = panel.onDidDispose(() => {
        const current = this.panels.get(key);
        if (current?.panel === panel) this.panels.delete(key);
      });
    } catch {
      try {
        panel.dispose();
      } catch {
        // ignore
      }
      return { ok: false, code: 'panel_open_failed' };
    }
    this.panels.set(key, { panel, disposeListener, document: created });
    let accepted = false;
    try {
      accepted = await panel.update(created);
    } catch {
      // ignore
    }
    if (!accepted || this.panels.get(key)?.panel !== panel) {
      try {
        disposeListener.dispose();
      } catch {
        // ignore
      }
      if (this.panels.get(key)?.panel === panel) this.panels.delete(key);
      try {
        panel.dispose();
      } catch {
        // ignore
      }
      return { ok: false, code: 'panel_open_failed' };
    }
    return { ok: true, code: 'opened' };
  }

  async upsert(
    context: PresentationContext,
    request: PresentationUpsertRequest,
  ): Promise<PresentationResult> {
    const validationError = validateRequest(request);
    if (validationError) return validationError;
    if (request.ownerTaskId !== context.callerTaskId) {
      return { ok: false, code: 'owner_mismatch' };
    }

    const document: PresentationDocument = {
      presentationId: request.presentationId,
      ownerTaskId: request.ownerTaskId,
      revision: request.revision,
      title: request.title,
      markdown: request.markdown,
    };
    const operationKey = this.operationKey(context.rootId, context.turnId, request.opId);
    const fingerprint = documentFingerprint(document);
    const priorFingerprint = this.operations.get(operationKey);
    if (priorFingerprint !== undefined) {
      return priorFingerprint === fingerprint
        ? { ok: true, code: 'idempotent' }
        : { ok: false, code: 'op_conflict' };
    }

    const key = this.presentationKey(context.rootId, request.presentationId);
    const existing = this.panels.get(key);
    if (existing) {
      if (document.ownerTaskId !== existing.document.ownerTaskId) {
        return { ok: false, code: 'owner_mismatch' };
      }
      if (document.revision <= existing.document.revision) {
        return { ok: false, code: 'stale_revision' };
      }
      let accepted = false;
      try {
        accepted = await existing.panel.update(document);
      } catch {
        // Presentation content and host errors must never cross this boundary.
      }
      if (!accepted || this.panels.get(key) !== existing) {
        return { ok: false, code: 'host_delivery_failed' };
      }
      existing.document = document;
      this.operations.set(operationKey, fingerprint);
      try {
        existing.panel.reveal();
      } catch {
        // Delivery succeeded; editor focus is best-effort and content-free.
      }
      return { ok: true, code: 'opened' };
    }

    let panel: PresentationPanel;
    try {
      panel = this.factory.create(document);
    } catch {
      return { ok: false, code: 'panel_open_failed' };
    }
    let disposeListener: { dispose(): void };
    try {
      disposeListener = panel.onDidDispose(() => {
        const current = this.panels.get(key);
        if (current?.panel === panel) {
          this.panels.delete(key);
        }
      });
    } catch {
      try {
        panel.dispose();
      } catch {
        // Preserve the stable failure result even if partial cleanup also fails.
      }
      return { ok: false, code: 'panel_open_failed' };
    }
    this.panels.set(key, { panel, disposeListener, document });
    let accepted = false;
    try {
      accepted = await panel.update(document);
    } catch {
      // Presentation content and host errors must never cross this boundary.
    }
    if (!accepted || this.panels.get(key)?.panel !== panel) {
      try {
        disposeListener.dispose();
      } catch {
        // Continue cleanup without exposing host errors.
      }
      const current = this.panels.get(key);
      if (current?.panel === panel) this.panels.delete(key);
      try {
        panel.dispose();
      } catch {
        // Preserve the stable failure result even if partial cleanup also fails.
      }
      return { ok: false, code: 'panel_open_failed' };
    }
    this.operations.set(operationKey, fingerprint);
    return { ok: true, code: 'opened' };
  }

  async restore(panel: PresentationPanel, state: unknown): Promise<PresentationResult> {
    if (!validatePersistedDocument(state)) {
      return { ok: false, code: 'restore_rejected' };
    }
    const key = this.presentationKey(state.rootId, state.presentationId);
    if (this.panels.has(key)) return { ok: false, code: 'restore_conflict' };

    const document: PresentationDocument = {
      presentationId: state.presentationId,
      ownerTaskId: state.ownerTaskId,
      revision: state.revision,
      title: state.title,
      markdown: state.markdown,
    };
    let disposeListener: { dispose(): void };
    try {
      disposeListener = panel.onDidDispose(() => {
        const current = this.panels.get(key);
        if (current?.panel === panel) this.panels.delete(key);
      });
    } catch {
      return { ok: false, code: 'host_delivery_failed' };
    }
    const entry = { panel, disposeListener, document };
    this.panels.set(key, entry);
    let accepted = false;
    try {
      accepted = await panel.update(document);
    } catch {
      // Persisted content and host errors must never cross this boundary.
    }
    if (!accepted || this.panels.get(key) !== entry) {
      try {
        disposeListener.dispose();
      } catch {
        // Preserve the stable delivery failure.
      }
      if (this.panels.get(key) === entry) this.panels.delete(key);
      return { ok: false, code: 'host_delivery_failed' };
    }
    return { ok: true, code: 'restored' };
  }

  dispose(): void {
    const entries = [...this.panels.values()];
    this.panels.clear();
    this.operations.clear();
    for (const entry of entries) {
      try {
        entry.disposeListener.dispose();
      } catch {
        // Continue releasing remaining host handles.
      }
      try {
        entry.panel.dispose();
      } catch {
        // Extension shutdown cleanup is best-effort and content-free.
      }
    }
  }

  private operationKey(rootId: string, turnId: string, opId: string): string {
    return `${rootId.length}:${rootId}${turnId.length}:${turnId}${opId}`;
  }

  private presentationKey(rootId: string, presentationId: string): string {
    return `${rootId.length}:${rootId}${presentationId}`;
  }
}
