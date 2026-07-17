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
const REQUIRED_DOCUMENT_KEYS = new Set([
  'presentationId',
  'ownerTaskId',
  'revision',
  'title',
  'markdown',
]);
const OPTIONAL_DOCUMENT_KEYS = new Set([
  'kind',
  'summary',
  'changeSummary',
  'sourcePath',
  'sourceFolderUri',
  'updatedAt',
]);
const DOCUMENT_KEYS = new Set([...REQUIRED_DOCUMENT_KEYS, ...OPTIONAL_DOCUMENT_KEYS]);

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
  getPresentation(presentationId: string): Promise<PresentationDocument | undefined>;
  putPresentation(document: PresentationDocument & { rootId: string; updatedAt: string; opFingerprint?: string }): Promise<void>;
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

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 40) return false;
  return Number.isFinite(Date.parse(value));
}

function parseOptionalBounded(
  value: unknown,
  max: number,
): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false;
  return value;
}

function parseDocumentFields(raw: Record<string, unknown>): PresentationDocument | undefined {
  if (Object.keys(raw).some((key) => !DOCUMENT_KEYS.has(key))) return undefined;
  for (const key of REQUIRED_DOCUMENT_KEYS) {
    if (!(key in raw)) return undefined;
  }
  if (
    !isStableId(raw.presentationId) ||
    !isStableId(raw.ownerTaskId) ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) <= 0 ||
    typeof raw.title !== 'string' ||
    raw.title.length === 0 ||
    raw.title.length > PRESENTATION_TITLE_MAX_LENGTH ||
    typeof raw.markdown !== 'string' ||
    raw.markdown.length === 0 ||
    raw.markdown.length > PRESENTATION_MARKDOWN_MAX_LENGTH
  ) {
    return undefined;
  }
  const doc: PresentationDocument = {
    presentationId: raw.presentationId as string,
    ownerTaskId: raw.ownerTaskId as string,
    revision: raw.revision as number,
    title: raw.title as string,
    markdown: raw.markdown as string,
  };
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== 'string' || !KIND_VALUES.has(raw.kind)) return undefined;
    doc.kind = raw.kind as PresentationKind;
  }
  const summary = parseOptionalBounded(raw.summary, SUMMARY_MAX_LENGTH);
  if (summary === false) return undefined;
  if (summary !== undefined) doc.summary = summary;
  const changeSummary = parseOptionalBounded(raw.changeSummary, CHANGE_SUMMARY_MAX_LENGTH);
  if (changeSummary === false) return undefined;
  if (changeSummary !== undefined) doc.changeSummary = changeSummary;
  const sourcePath = parseOptionalBounded(raw.sourcePath, 4096);
  if (sourcePath === false) return undefined;
  if (sourcePath !== undefined) doc.sourcePath = sourcePath;
  const sourceFolderUri = parseOptionalBounded(raw.sourceFolderUri, 4096);
  if (sourceFolderUri === false) return undefined;
  if (sourceFolderUri !== undefined) doc.sourceFolderUri = sourceFolderUri;
  if (raw.updatedAt !== undefined) {
    if (!isIsoTimestamp(raw.updatedAt)) return undefined;
    doc.updatedAt = raw.updatedAt;
  }
  return doc;
}

function parsePersistedState(value: unknown): PersistedPresentationState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  // Accept only opaque ID handles. Full document restore from serializer is rejected.
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
    request.markdown.length === 0
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

export class PresentationManager {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly operations = new Map<string, string>();
  private ownerResolver: OwnerResolver | undefined;
  private documentStore: PresentationDocumentStore | undefined;
  /** Restores that arrived before the SQLite store was wired. */
  private pendingRestores: Array<{
    panel: PresentationPanel;
    state: unknown;
    resolve: (result: PresentationResult) => void;
  }> = [];

  constructor(private readonly factory: PresentationPanelFactory) {}

  /** Resolve an owner task to its authenticated root during restore validation. */
  setOwnerResolver(resolver: OwnerResolver | undefined): void {
    this.ownerResolver = resolver;
  }

  /** SQLite-backed presentation document store (required for restart restore). */
  setDocumentStore(store: PresentationDocumentStore | undefined): void {
    this.documentStore = store;
    if (!store) return;
    const pending = this.pendingRestores;
    this.pendingRestores = [];
    for (const entry of pending) {
      void this.restore(entry.panel, entry.state).then(entry.resolve);
    }
  }

  private async persistDocument(
    rootId: string,
    document: PresentationDocument,
    opFingerprint?: string,
  ): Promise<boolean> {
    // Fail closed: never claim durable success without a store (persist-before-visible).
    if (!this.documentStore) return false;
    try {
      await this.documentStore.putPresentation({
        ...document,
        rootId,
        updatedAt: document.updatedAt ?? new Date().toISOString(),
        ...(opFingerprint ? { opFingerprint } : {}),
      });
      return true;
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
        existing.document.ownerTaskId === document.ownerTaskId &&
        existing.document.sourcePath === document.sourcePath &&
        existing.document.sourceFolderUri === document.sourceFolderUri;
      if (sameContent) {
        try {
          existing.panel.reveal();
        } catch {
          // best-effort focus
        }
        return { ok: true, code: 'idempotent' };
      }
      const next = stampUpdatedAt({
        presentationId: document.presentationId,
        ownerTaskId: existing.document.ownerTaskId,
        revision: existing.document.revision + 1,
        title: document.title,
        markdown: document.markdown,
        kind: document.kind ?? existing.document.kind ?? 'document',
        summary: document.summary,
        changeSummary: document.changeSummary,
        sourcePath: document.sourcePath,
        sourceFolderUri: document.sourceFolderUri,
      });
      const durable = await this.persistDocument(rootId, next);
      if (!durable) return { ok: false, code: 'host_delivery_failed' };
      let accepted = false;
      try {
        accepted = await existing.panel.update(next, rootId);
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

    const created = stampUpdatedAt({
      presentationId: document.presentationId,
      ownerTaskId: document.ownerTaskId,
      revision: document.revision && document.revision > 0 ? document.revision : 1,
      title: document.title,
      markdown: document.markdown,
      kind: document.kind ?? 'document',
      summary: document.summary,
      changeSummary: document.changeSummary,
      sourcePath: document.sourcePath,
      sourceFolderUri: document.sourceFolderUri,
    });
    return this.createAndDeliver(rootId, key, created);
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

    const document = stampUpdatedAt(base);
    const key = this.presentationKey(context.rootId, request.presentationId);
    const existing = this.panels.get(key);
    if (existing) {
      if (document.ownerTaskId !== existing.document.ownerTaskId) {
        return { ok: false, code: 'owner_mismatch' };
      }
      if (document.revision <= existing.document.revision) {
        return { ok: false, code: 'stale_revision' };
      }
      const durable = await this.persistDocument(context.rootId, document, fingerprint);
      if (!durable) return { ok: false, code: 'host_delivery_failed' };
      let accepted = false;
      try {
        accepted = await existing.panel.update(document, context.rootId);
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

    const result = await this.createAndDeliver(context.rootId, key, document);
    if (result.ok) this.operations.set(operationKey, fingerprint);
    return result;
  }

  async restore(panel: PresentationPanel, state: unknown): Promise<PresentationResult> {
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
    const loaded = await this.documentStore.getPresentation(presentationId);
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

  private async createAndDeliver(
    rootId: string,
    key: string,
    document: PresentationDocument,
  ): Promise<PresentationResult> {
    const durable = await this.persistDocument(rootId, document);
    if (!durable) return { ok: false, code: 'host_delivery_failed' };
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
      return { ok: false, code: 'panel_open_failed' };
    }
    return { ok: true, code: 'opened' };
  }

  private operationKey(rootId: string, turnId: string, opId: string): string {
    return `${rootId.length}:${rootId}${turnId.length}:${turnId}${opId}`;
  }

  private presentationKey(rootId: string, presentationId: string): string {
    return `${rootId.length}:${rootId}${presentationId}`;
  }
}
