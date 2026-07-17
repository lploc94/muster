const MESSAGE_KEYS = new Set(['type', 'document', 'rootId']);
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
const ENVELOPE_KEYS = new Set(['rootId', 'document']);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ID_MAX_LENGTH = 128;
const TITLE_MAX_LENGTH = 200;
const MARKDOWN_MAX_LENGTH = 100_000;
const SUMMARY_MAX_LENGTH = 600;
const CHANGE_SUMMARY_MAX_LENGTH = 1000;
const KIND_VALUES = new Set(['plan', 'spec', 'document']);

export type PresentationKind = 'plan' | 'spec' | 'document';

export interface PresentationRevealRequest {
  type: 'revealLinkedChat';
}
export type PresentationRevealStatus = 'success' | 'failure';
export interface PresentationRevealResult {
  type: 'revealLinkedChatResult';
  status: PresentationRevealStatus;
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

export interface PersistedPresentationState {
  rootId: string;
  document: PresentationDocument;
}

export function parsePresentationRevealRequest(value: unknown): PresentationRevealRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 1 && message.type === 'revealLinkedChat'
    ? { type: 'revealLinkedChat' }
    : undefined;
}

export function parsePresentationRevealResult(value: unknown): PresentationRevealResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).length !== 2 || message.type !== 'revealLinkedChatResult') return undefined;
  return message.status === 'success' || message.status === 'failure'
    ? { type: 'revealLinkedChatResult', status: message.status }
    : undefined;
}

function isStableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ID_MAX_LENGTH &&
    STABLE_ID_PATTERN.test(value)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 40) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function parseOptionalString(
  value: unknown,
  max: number,
  allowEmpty = false,
): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value.length === 0) return false;
  if (value.length > max) return false;
  return value;
}

export function parsePresentationDocument(value: unknown): PresentationDocument | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
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
    raw.title.length > TITLE_MAX_LENGTH ||
    typeof raw.markdown !== 'string' ||
    raw.markdown.length === 0 ||
    raw.markdown.length > MARKDOWN_MAX_LENGTH
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
  const summary = parseOptionalString(raw.summary, SUMMARY_MAX_LENGTH);
  if (summary === false) return undefined;
  if (summary !== undefined) doc.summary = summary;
  const changeSummary = parseOptionalString(raw.changeSummary, CHANGE_SUMMARY_MAX_LENGTH);
  if (changeSummary === false) return undefined;
  if (changeSummary !== undefined) doc.changeSummary = changeSummary;
  const sourcePath = parseOptionalString(raw.sourcePath, 4096);
  if (sourcePath === false) return undefined;
  if (sourcePath !== undefined) doc.sourcePath = sourcePath;
  const sourceFolderUri = parseOptionalString(raw.sourceFolderUri, 4096);
  if (sourceFolderUri === false) return undefined;
  if (sourceFolderUri !== undefined) doc.sourceFolderUri = sourceFolderUri;
  if (raw.updatedAt !== undefined) {
    if (!isIsoTimestamp(raw.updatedAt)) return undefined;
    doc.updatedAt = raw.updatedAt;
  }
  return doc;
}

export function parsePersistedPresentationState(value: unknown): PersistedPresentationState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((k) => !ENVELOPE_KEYS.has(k))) return undefined;
  if (!isStableId(raw.rootId)) return undefined;
  const document = parsePresentationDocument(raw.document);
  if (!document) return undefined;
  return { rootId: raw.rootId, document };
}

export function parsePresentationUpdate(
  value: unknown,
): { document: PresentationDocument; rootId: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some((key) => !MESSAGE_KEYS.has(key))) return undefined;
  if (message.type !== 'presentationUpdate') return undefined;
  const document = parsePresentationDocument(message.document);
  if (!document) return undefined;
  if (!isStableId(message.rootId)) return undefined;
  return { document, rootId: message.rootId };
}

export function applyPresentationUpdate(
  current: PresentationDocument | undefined,
  message: unknown,
): PresentationDocument | undefined {
  const next = parsePresentationUpdate(message);
  if (!next) return current;
  if (!current) return next.document;
  if (
    next.document.presentationId !== current.presentationId ||
    next.document.ownerTaskId !== current.ownerTaskId ||
    next.document.revision <= current.revision
  ) {
    return current;
  }
  return next.document;
}

export function buildPersistedState(
  rootId: string,
  document: PresentationDocument,
): PersistedPresentationState | undefined {
  return isStableId(rootId) ? { rootId, document } : undefined;
}

export function kindLabel(kind: PresentationKind | undefined): string {
  if (kind === 'plan') return 'Plan';
  if (kind === 'spec') return 'Spec';
  return 'Document';
}
