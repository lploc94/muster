import {
  SEND_OUTBOX_MENTION_BINDINGS_MAX,
  SEND_OUTBOX_PATH_MAX,
  SEND_OUTBOX_SKILLS_MAX,
  SEND_OUTBOX_TEXT_MAX,
} from '../task/repository';

const SEND_KEYS = new Set([
  'type',
  'taskId',
  'text',
  'llmText',
  'backend',
  'model',
  'continuationOf',
  'skills',
  'clientRequestId',
  'mentionBindings',
]);
const BACKENDS = new Set(['claude', 'grok', 'kiro', 'codex', 'opencode']);
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ID_MAX = 256;
const MODEL_MAX = 512;
const MENTION_LABEL_MAX = 512;

export interface HostSendRequest {
  type: 'send';
  taskId?: string;
  text: string;
  llmText?: string;
  backend?: string;
  model?: string;
  continuationOf?: string;
  skills?: string[];
  clientRequestId: string;
  mentionBindings?: Array<[string, string]>;
}

export type HostSendRequestParseResult =
  | { ok: true; value: HostSendRequest }
  | { ok: false; clientRequestId?: string; taskId?: string };

function boundedStableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ID_MAX &&
    STABLE_ID.test(value)
  );
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0]/.test(value);
}

function parseMentionBindings(value: unknown): Array<[string, string]> | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SEND_OUTBOX_MENTION_BINDINGS_MAX) return false;
  const result: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0].length === 0 ||
      entry[0].length > MENTION_LABEL_MAX ||
      /[\0\r\n]/.test(entry[0]) ||
      typeof entry[1] !== 'string' ||
      entry[1].length === 0 ||
      entry[1].length > SEND_OUTBOX_PATH_MAX ||
      /[\0\r\n]/.test(entry[1]) ||
      seen.has(entry[0])
    ) {
      return false;
    }
    seen.add(entry[0]);
    result.push([entry[0], entry[1]]);
  }
  return result.length > 0 ? result : undefined;
}

function parseSkills(value: unknown): string[] | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SEND_OUTBOX_SKILLS_MAX) return false;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > 128 ||
      !SKILL_NAME.test(entry) ||
      seen.has(entry)
    ) {
      return false;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** Strict current-protocol parser before any durable outbox write. */
export function parseHostSendRequest(value: unknown): HostSendRequestParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  const raw = value as Record<string, unknown>;
  const correlation = boundedStableId(raw.clientRequestId) ? raw.clientRequestId : undefined;
  const taskIdForError = boundedStableId(raw.taskId) ? raw.taskId : undefined;
  const invalid = (): HostSendRequestParseResult => ({
    ok: false,
    ...(correlation ? { clientRequestId: correlation } : {}),
    ...(taskIdForError ? { taskId: taskIdForError } : {}),
  });
  if (raw.type !== 'send' || Object.keys(raw).some((key) => !SEND_KEYS.has(key))) return invalid();
  if (!correlation || !boundedText(raw.text, SEND_OUTBOX_TEXT_MAX)) return invalid();
  if (raw.taskId !== undefined && !boundedStableId(raw.taskId)) return invalid();
  if (raw.continuationOf !== undefined && !boundedStableId(raw.continuationOf)) return invalid();
  if (raw.llmText !== undefined && !boundedText(raw.llmText, SEND_OUTBOX_TEXT_MAX)) return invalid();
  if (raw.backend !== undefined && (typeof raw.backend !== 'string' || !BACKENDS.has(raw.backend))) {
    return invalid();
  }
  if (
    raw.model !== undefined &&
    (typeof raw.model !== 'string' || raw.model.length === 0 || raw.model.length > MODEL_MAX || /[\0\r\n]/.test(raw.model))
  ) {
    return invalid();
  }
  const skills = parseSkills(raw.skills);
  const mentionBindings = parseMentionBindings(raw.mentionBindings);
  if (skills === false || mentionBindings === false) return invalid();
  return {
    ok: true,
    value: {
      type: 'send',
      clientRequestId: correlation,
      text: raw.text as string,
      ...(raw.taskId !== undefined ? { taskId: raw.taskId as string } : {}),
      ...(raw.llmText !== undefined ? { llmText: raw.llmText as string } : {}),
      ...(raw.backend !== undefined ? { backend: raw.backend as string } : {}),
      ...(raw.model !== undefined ? { model: raw.model as string } : {}),
      ...(raw.continuationOf !== undefined ? { continuationOf: raw.continuationOf as string } : {}),
      ...(skills ? { skills } : {}),
      ...(mentionBindings ? { mentionBindings } : {}),
    },
  };
}
