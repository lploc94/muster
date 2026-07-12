const MESSAGE_KEYS = new Set(['type', 'document']);
const DOCUMENT_KEYS = new Set(['presentationId', 'ownerTaskId', 'revision', 'title', 'markdown']);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ID_MAX_LENGTH = 128;
const TITLE_MAX_LENGTH = 200;
const MARKDOWN_MAX_LENGTH = 100_000;

export interface PresentationRevealRequest { type: 'revealLinkedChat' }
export type PresentationRevealStatus = 'success' | 'failure';
export interface PresentationRevealResult {
  type: 'revealLinkedChatResult';
  status: PresentationRevealStatus;
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

export interface PresentationDocument {
  presentationId: string;
  ownerTaskId: string;
  revision: number;
  title: string;
  markdown: string;
}

export function parsePersistedPresentation(value: unknown): PresentationDocument | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const document = value as Record<string, unknown>;
  if (Object.keys(document).some((key) => !DOCUMENT_KEYS.has(key))) return undefined;
  if (
    !isStableId(document.presentationId) ||
    !isStableId(document.ownerTaskId) ||
    !Number.isSafeInteger(document.revision) ||
    (document.revision as number) <= 0 ||
    typeof document.title !== 'string' ||
    document.title.length === 0 ||
    document.title.length > TITLE_MAX_LENGTH ||
    typeof document.markdown !== 'string' ||
    document.markdown.length === 0 ||
    document.markdown.length > MARKDOWN_MAX_LENGTH
  ) {
    return undefined;
  }
  return document as unknown as PresentationDocument;
}

export function parsePresentationUpdate(value: unknown): PresentationDocument | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some((key) => !MESSAGE_KEYS.has(key))) return undefined;
  if (message.type !== 'presentationUpdate') return undefined;
  return parsePersistedPresentation(message.document);
}

export function applyPresentationUpdate(
  current: PresentationDocument | undefined,
  message: unknown,
): PresentationDocument | undefined {
  const next = parsePresentationUpdate(message);
  if (!next) return current;
  if (!current) return next;
  if (
    next.presentationId !== current.presentationId ||
    next.ownerTaskId !== current.ownerTaskId ||
    next.revision <= current.revision
  ) {
    return current;
  }
  return next;
}
