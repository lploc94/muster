import { createHash } from 'crypto';
import {
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from '../task/coordinator-tools';

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SUMMARY_MAX_LENGTH = 600;
const CHANGE_SUMMARY_MAX_LENGTH = 1000;
const KIND_VALUES = new Set(['plan', 'spec', 'document']);
const REQUEST_KEYS = new Set([
  'presentationId',
  'ownerTaskId',
  'opId',
  'revision',
  'title',
  'markdown',
  'kind',
  'summary',
  'changeSummary',
]);

export type PresentationKind = 'plan' | 'spec' | 'document';

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
  kind?: PresentationKind;
  summary?: string;
  changeSummary?: string;
}

export interface PresentationDocument {
  presentationId: string;
  ownerTaskId: string;
  revision: number;
  title: string;
  markdown: string;
  kind?: PresentationKind;
  summary?: string;
  changeSummary?: string;
  sourcePath?: string;
  sourceFolderUri?: string;
  updatedAt?: string;
}

export interface PresentationPanel {
  update(
    document: PresentationDocument,
    rootId: string,
  ): Promise<boolean>;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
  navigateFragment?(fragment: string): PromiseLike<boolean> | boolean;
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

/** Opaque serializer handle — SQLite is canonical document storage. */
export interface PersistedPresentationState {
  rootId: string;
  presentationId: string;
}

export type PresentationDocumentStore = {
  getPresentation(rootId: string, presentationId: string): Promise<PresentationDocument | undefined>;
  putPresentation(document: PresentationDocument & { rootId: string; updatedAt: string }): Promise<boolean>;
  commitPresentationOperation(args: {
    operationKey: string;
    fingerprint: string;
    document: PresentationDocument & { rootId: string; updatedAt: string };
  }): Promise<'committed' | 'idempotent' | 'op_conflict' | 'stale_revision' | 'owner_mismatch'>;
};

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

function parsePersistedState(value: unknown): PersistedPresentationState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  // Accept only opaque ID handles. Full document restore from serializer is rejected.
  if (Object.keys(raw).length !== 2 || !('rootId' in raw) || !('presentationId' in raw)) {
    return undefined;
  }
  if (!isStableId(raw.rootId) || !isStableId(raw.presentationId)) return undefined;
  return { rootId: raw.rootId, presentationId: raw.presentationId };
}

/** Fingerprint coordinator-owned fields only (excludes host stamps). */
function documentFingerprint(document: PresentationDocument): string {
  const payload = {
    presentationId: document.presentationId,
    ownerTaskId: document.ownerTaskId,
    revision: document.revision,
    title: document.title,
    markdown: document.markdown,
    kind: document.kind,
    summary: document.summary,
    changeSummary: document.changeSummary,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function stampUpdatedAt(document: PresentationDocument): PresentationDocument {
  return { ...document, updatedAt: new Date().toISOString() };
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
      request.markdown.length > PRESENTATION_MARKDOWN_MAX_LENGTH) ||
    (typeof request.summary === 'string' && request.summary.length > SUMMARY_MAX_LENGTH) ||
    (typeof request.changeSummary === 'string' &&
      request.changeSummary.length > CHANGE_SUMMARY_MAX_LENGTH)
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
    request.markdown.length === 0 ||
    request.markdown.includes('\0')
  ) {
    return { ok: false, code: 'invalid_arguments' };
  }
  if (request.kind !== undefined && !KIND_VALUES.has(request.kind)) {
    return { ok: false, code: 'invalid_arguments' };
  }
  if (request.summary !== undefined && (typeof request.summary !== 'string' || request.summary.length === 0)) {
    return { ok: false, code: 'invalid_arguments' };
  }
  if (
    request.changeSummary !== undefined &&
    (typeof request.changeSummary !== 'string' || request.changeSummary.length === 0)
  ) {
    return { ok: false, code: 'invalid_arguments' };
  }
  return undefined;
}

export type OwnerResolver = (ownerTaskId: string) => string | undefined;

interface PanelEntry {
  panel: PresentationPanel;
  disposeListener: { dispose(): void };
  document: PresentationDocument;
  rootId: string;
}

interface PendingRestore {
  panel: PresentationPanel;
  state: unknown;
  resolve: (result: PresentationResult) => void;
}

type PresentationDeliveryResult = 'ok' | 'panel_open_failed' | 'host_delivery_failed';

export class PresentationManager {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly operations = new Map<string, string>();
  private disposed = false;
  private ownerResolver: OwnerResolver | undefined;
  private documentStore: PresentationDocumentStore | undefined;
  /** Restores that arrived before the SQLite store was wired. */
  private pendingRestores: PendingRestore[] = [];
  /** Queued restores currently blocked inside the durable store read. */
  private readonly inFlightRestores = new Set<PendingRestore>();
  /** Avoid double-dispose when a cancelled durable read eventually resumes. */
  private readonly cancelledRestorePanels = new WeakSet<PresentationPanel>();

  constructor(private readonly factory: PresentationPanelFactory) {}

  /** Resolve an owner task to its authenticated root during restore validation. */
  setOwnerResolver(resolver: OwnerResolver | undefined): void {
    this.ownerResolver = resolver;
  }

  /** SQLite-backed presentation document store (required for restart restore). */
  setDocumentStore(store: PresentationDocumentStore | undefined): void {
    if (this.disposed) return;
    this.documentStore = store;
    if (!store) return;
    const pending = this.pendingRestores;
    this.pendingRestores = [];
    for (const entry of pending) {
      this.inFlightRestores.add(entry);
      void this.restore(entry.panel, entry.state).then(
        (result) => this.settleInFlightRestore(entry, result),
        () => this.settleInFlightRestore(entry, { ok: false, code: 'restore_rejected' }),
      );
    }
  }

  private async persistDocument(
    rootId: string,
    document: PresentationDocument,
  ): Promise<boolean> {
    // Fail closed: never claim durable success without a store (persist-before-visible).
    if (!this.documentStore) return false;
    try {
      return await this.documentStore.putPresentation({
        ...document,
        rootId,
        updatedAt: document.updatedAt ?? new Date().toISOString(),
      });
    } catch {
      return false;
    }
  }

  /**
   * User-initiated open (e.g. click a workspace `.md` link in chat).
   */
  async openWorkspaceDocument(
    rootId: string,
    document: Omit<PresentationDocument, 'revision'> & { revision?: number },
  ): Promise<PresentationResult> {
    if (this.disposed) return { ok: false, code: 'host_delivery_failed' };
    if (!isStableId(rootId) || !isStableId(document.presentationId) || !isStableId(document.ownerTaskId)) {
      return { ok: false, code: 'invalid_arguments' };
    }
    if (
      typeof document.title !== 'string' ||
      document.title.length === 0 ||
      document.title.length > PRESENTATION_TITLE_MAX_LENGTH ||
      typeof document.markdown !== 'string' ||
      document.markdown.length === 0 ||
      document.markdown.length > PRESENTATION_MARKDOWN_MAX_LENGTH ||
      document.markdown.includes('\0')
    ) {
      return { ok: false, code: 'invalid_arguments' };
    }

    if (!this.documentStore) return { ok: false, code: 'host_delivery_failed' };
    let stored: PresentationDocument | undefined;
    try {
      stored = await this.documentStore.getPresentation(rootId, document.presentationId);
    } catch {
      return { ok: false, code: 'host_delivery_failed' };
    }
    if (this.disposed) return { ok: false, code: 'host_delivery_failed' };
    if (stored && stored.ownerTaskId !== document.ownerTaskId) {
      return { ok: false, code: 'owner_mismatch' };
    }
    const sameContent = Boolean(
      stored &&
      stored.title === document.title &&
      stored.markdown === document.markdown &&
      stored.sourcePath === document.sourcePath &&
      stored.sourceFolderUri === document.sourceFolderUri,
    );
    const key = this.presentationKey(rootId, document.presentationId);
    if (stored && sameContent) {
      const delivered = await this.deliverCanonicalDocument(rootId, key, stored);
      return delivered === 'ok'
        ? { ok: true, code: 'idempotent' }
        : { ok: false, code: delivered };
    }

    const next = stampUpdatedAt({
      presentationId: document.presentationId,
      ownerTaskId: stored?.ownerTaskId ?? document.ownerTaskId,
      revision: stored
        ? stored.revision + 1
        : document.revision && document.revision > 0
          ? document.revision
          : 1,
      title: document.title,
      markdown: document.markdown,
      kind: document.kind ?? stored?.kind ?? 'document',
      summary: document.summary,
      changeSummary: document.changeSummary,
      sourcePath: document.sourcePath,
      sourceFolderUri: document.sourceFolderUri,
    });
    const durable = await this.persistDocument(rootId, next);
    if (!durable) return { ok: false, code: 'host_delivery_failed' };
    const delivered = await this.deliverCanonicalDocument(rootId, key, next);
    return delivered === 'ok'
      ? { ok: true, code: 'opened' }
      : { ok: false, code: delivered };
  }

  async upsert(
    context: PresentationContext,
    request: PresentationUpsertRequest,
  ): Promise<PresentationResult> {
    if (this.disposed) return { ok: false, code: 'host_delivery_failed' };
    const validationError = validateRequest(request);
    if (validationError) return validationError;
    if (request.ownerTaskId !== context.callerTaskId) {
      return { ok: false, code: 'owner_mismatch' };
    }

    const base: PresentationDocument = {
      presentationId: request.presentationId,
      ownerTaskId: request.ownerTaskId,
      revision: request.revision,
      title: request.title,
      markdown: request.markdown,
    };
    if (request.kind !== undefined) base.kind = request.kind;
    if (request.summary !== undefined) base.summary = request.summary;
    if (request.changeSummary !== undefined) base.changeSummary = request.changeSummary;

    const operationKey = this.operationKey(context.rootId, context.turnId, request.opId);
    const fingerprint = documentFingerprint(base);
    const priorFingerprint = this.operations.get(operationKey);
    if (priorFingerprint !== undefined) {
      return priorFingerprint === fingerprint
        ? { ok: true, code: 'idempotent' }
        : { ok: false, code: 'op_conflict' };
    }

    if (!this.documentStore) return { ok: false, code: 'host_delivery_failed' };
    const document = stampUpdatedAt(base);
    let status: Awaited<ReturnType<PresentationDocumentStore['commitPresentationOperation']>>;
    try {
      status = await this.documentStore.commitPresentationOperation({
        operationKey,
        fingerprint,
        document: { ...document, rootId: context.rootId, updatedAt: document.updatedAt! },
      });
    } catch {
      return { ok: false, code: 'host_delivery_failed' };
    }
    if (this.disposed) return { ok: false, code: 'host_delivery_failed' };
    if (status === 'op_conflict') return { ok: false, code: 'op_conflict' };
    if (status === 'stale_revision') return { ok: false, code: 'stale_revision' };
    if (status === 'owner_mismatch') return { ok: false, code: 'owner_mismatch' };

    let canonical = document;
    if (status === 'idempotent') {
      try {
        const loaded = await this.documentStore.getPresentation(
          context.rootId,
          request.presentationId,
        );
        if (!loaded) return { ok: false, code: 'host_delivery_failed' };
        canonical = loaded;
      } catch {
        return { ok: false, code: 'host_delivery_failed' };
      }
      if (this.disposed) return { ok: false, code: 'host_delivery_failed' };
    }
    const key = this.presentationKey(context.rootId, request.presentationId);
    const delivered = await this.deliverCanonicalDocument(context.rootId, key, canonical);
    if (delivered !== 'ok') {
      return { ok: false, code: delivered };
    }
    this.operations.set(operationKey, fingerprint);
    return { ok: true, code: status === 'idempotent' ? 'idempotent' : 'opened' };
  }

  async restore(panel: PresentationPanel, state: unknown): Promise<PresentationResult> {
    if (this.disposed) return { ok: false, code: 'restore_rejected' };
    const parsed = parsePersistedState(state);
    if (!parsed) {
      return { ok: false, code: 'restore_rejected' };
    }
    // Serializer may run before engine/store is ready; queue until store is wired.
    if (!this.documentStore) {
      return new Promise<PresentationResult>((resolve) => {
        this.pendingRestores.push({ panel, state, resolve });
      });
    }
    const { rootId, presentationId } = parsed;
    let loaded: PresentationDocument | undefined;
    try {
      loaded = await this.documentStore.getPresentation(rootId, presentationId);
    } catch {
      return { ok: false, code: 'restore_rejected' };
    }
    if (this.disposed) {
      if (!this.cancelledRestorePanels.has(panel)) {
        this.cancelledRestorePanels.add(panel);
        try {
          panel.dispose();
        } catch {
          // Disposal already owns this restore; keep the stable rejection.
        }
      }
      return { ok: false, code: 'restore_rejected' };
    }
    if (!loaded) {
      return { ok: false, code: 'restore_rejected' };
    }
    const document = loaded;

    // When resolver is wired: require owner maps to the envelope rootId (fail closed).
    if (this.ownerResolver) {
      const resolved = this.ownerResolver(document.ownerTaskId);
      if (!resolved || resolved !== rootId) {
        return { ok: false, code: 'restore_rejected' };
      }
    }

    const key = this.presentationKey(rootId, document.presentationId);
    if (this.panels.has(key)) return { ok: false, code: 'restore_conflict' };

    let disposeListener: { dispose(): void };
    try {
      disposeListener = panel.onDidDispose(() => {
        const current = this.panels.get(key);
        if (current?.panel === panel) this.panels.delete(key);
      });
    } catch {
      return { ok: false, code: 'host_delivery_failed' };
    }
    const entry: PanelEntry = { panel, disposeListener, document, rootId };
    this.panels.set(key, entry);
    let accepted = false;
    try {
      accepted = await panel.update(document, rootId);
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

  navigateFragment(
    rootId: string,
    presentationId: string,
    fragment: string,
  ): boolean {
    if (!isStableId(rootId) || !isStableId(presentationId)) return false;
    if (!/^[A-Za-z0-9._:-]+$/.test(fragment)) return false;
    const entry = this.panels.get(this.presentationKey(rootId, presentationId));
    if (!entry?.panel.navigateFragment) return false;
    try {
      void entry.panel.navigateFragment(fragment);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.documentStore = undefined;
    const pending = [...this.pendingRestores, ...this.inFlightRestores];
    this.pendingRestores = [];
    this.inFlightRestores.clear();
    for (const entry of pending) {
      entry.resolve({ ok: false, code: 'restore_rejected' });
      this.cancelledRestorePanels.add(entry.panel);
      try {
        entry.panel.dispose();
      } catch {
        // Continue releasing live panels.
      }
    }
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

  private async deliverCanonicalDocument(
    rootId: string,
    key: string,
    document: PresentationDocument,
  ): Promise<PresentationDeliveryResult> {
    if (this.disposed) return 'host_delivery_failed';
    const existing = this.panels.get(key);
    if (existing) {
      if (existing.document.ownerTaskId !== document.ownerTaskId) return 'host_delivery_failed';
      const same = documentFingerprint(existing.document) === documentFingerprint(document);
      if (document.revision < existing.document.revision) return 'host_delivery_failed';
      if (document.revision === existing.document.revision && !same) return 'host_delivery_failed';
      if (!same) {
        let accepted = false;
        try {
          accepted = await existing.panel.update(document, rootId);
        } catch {
          // Content-free failure.
        }
        if (!accepted || this.panels.get(key) !== existing) return 'host_delivery_failed';
        existing.document = document;
      }
      try {
        existing.panel.reveal();
      } catch {
        // Canonical delivery succeeded; focus is best-effort.
      }
      return 'ok';
    }

    let panel: PresentationPanel;
    try {
      panel = this.factory.create(document);
    } catch {
      return 'panel_open_failed';
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
      return 'panel_open_failed';
    }
    this.panels.set(key, { panel, disposeListener, document, rootId });
    let accepted = false;
    try {
      accepted = await panel.update(document, rootId);
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
      return 'panel_open_failed';
    }
    return 'ok';
  }

  private operationKey(rootId: string, turnId: string, opId: string): string {
    return createHash('sha256')
      .update(`${rootId.length}:${rootId}${turnId.length}:${turnId}${opId}`)
      .digest('hex');
  }

  private presentationKey(rootId: string, presentationId: string): string {
    return `${rootId.length}:${rootId}${presentationId}`;
  }

  private settleInFlightRestore(entry: PendingRestore, result: PresentationResult): void {
    // dispose() already rejected/settled entries removed from this set.
    if (!this.inFlightRestores.delete(entry)) return;
    entry.resolve(result);
  }
}
