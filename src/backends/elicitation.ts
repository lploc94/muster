/**
 * Pure ACP RFD Elicitation parsers/encoders.
 * @see https://agentclientprotocol.com/rfds/elicitation.md
 */

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export type ElicitationFieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'multiEnum';

export type ElicitationStringFormat = 'email' | 'uri' | 'date' | 'date-time';

export interface ElicitationField {
  key: string;
  type: ElicitationFieldType;
  title?: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: ElicitationStringFormat;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  options?: string[];
  /** Claude AskUserQuestion companion free-text (`${key}_custom`). */
  allowCustom?: boolean;
}

export type JsonRpcId = string | number;

export interface ParsedFormElicitation {
  kind: 'form';
  sessionId?: string;
  requestId?: JsonRpcId;
  toolCallId?: string;
  message: string;
  fields: ElicitationField[];
  required: string[];
}

export interface ParsedUrlElicitation {
  kind: 'url';
  sessionId?: string;
  requestId?: JsonRpcId;
  elicitationId: string;
  url: string;
  message: string;
}

export interface ParsedUrlRequiredEntry {
  kind: 'urlRequired';
  elicitationId: string;
  url: string;
  message: string;
}

export type ParseElicitationResult =
  | ParsedFormElicitation
  | ParsedUrlElicitation
  | { kind: 'error'; code: number; message: string };

export interface AgentQuestion {
  prompt: string;
  options?: string[];
  allowFreeText?: boolean;
  multiSelect?: boolean;
  fieldKey?: string;
}

export type QuestionAnswers = Record<string, { selected: string[]; freeText: string | null }>;

const STRING_FORMATS = new Set<ElicitationStringFormat>(['email', 'uri', 'date', 'date-time']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionLabelsFromSchema(schema: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(schema.oneOf)) {
    const labels = schema.oneOf
      .map((entry) => {
        if (!isRecord(entry)) return null;
        if (typeof entry.const === 'string') return entry.const;
        if (typeof entry.title === 'string') return entry.title;
        return null;
      })
      .filter((label): label is string => typeof label === 'string' && label.length > 0);
    return labels.length > 0 ? labels : undefined;
  }
  if (Array.isArray(schema.anyOf)) {
    return optionLabelsFromSchema({ oneOf: schema.anyOf });
  }
  if (Array.isArray(schema.enum)) {
    const labels = schema.enum.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return labels.length > 0 ? labels : undefined;
  }
  if (isRecord(schema.items)) {
    return optionLabelsFromSchema(schema.items);
  }
  return undefined;
}

function parseField(key: string, raw: unknown, required: Set<string>): ElicitationField | { error: string } {
  if (!isRecord(raw)) {
    return { error: `property ${key} must be an object schema` };
  }
  const title = typeof raw.title === 'string' ? raw.title : undefined;
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const type = raw.type;

  if (type === 'array') {
    const options = optionLabelsFromSchema(raw);
    if (!options?.length) {
      return { error: `property ${key}: multi-select requires enum/oneOf options` };
    }
    const field: ElicitationField = {
      key,
      type: 'multiEnum',
      title,
      description,
      options,
      required: required.has(key),
      default: raw.default,
    };
    if (typeof raw.minItems === 'number') field.minItems = raw.minItems;
    if (typeof raw.maxItems === 'number') field.maxItems = raw.maxItems;
    return field;
  }

  const options = optionLabelsFromSchema(raw);
  if (options?.length && (type === 'string' || type === undefined)) {
    return {
      key,
      type: 'enum',
      title,
      description,
      options,
      required: required.has(key),
      default: raw.default,
    };
  }

  if (type === 'boolean') {
    return {
      key,
      type: 'boolean',
      title,
      description,
      required: required.has(key),
      default: raw.default,
    };
  }

  if (type === 'number' || type === 'integer') {
    const field: ElicitationField = {
      key,
      type,
      title,
      description,
      required: required.has(key),
      default: raw.default,
    };
    if (typeof raw.minimum === 'number') field.minimum = raw.minimum;
    if (typeof raw.maximum === 'number') field.maximum = raw.maximum;
    return field;
  }

  if (type === 'string' || type === undefined) {
    const field: ElicitationField = {
      key,
      type: 'string',
      title,
      description,
      required: required.has(key),
      default: raw.default,
    };
    if (typeof raw.minLength === 'number') field.minLength = raw.minLength;
    if (typeof raw.maxLength === 'number') field.maxLength = raw.maxLength;
    if (typeof raw.pattern === 'string') field.pattern = raw.pattern;
    if (typeof raw.format === 'string') {
      if (!STRING_FORMATS.has(raw.format as ElicitationStringFormat)) {
        return { error: `property ${key}: unsupported string format ${raw.format}` };
      }
      field.format = raw.format as ElicitationStringFormat;
    }
    return field;
  }

  return { error: `property ${key}: unsupported type ${String(type)}` };
}

function parseCreateScope(params: Record<string, unknown>):
  | { ok: true; sessionId?: string; requestId?: JsonRpcId; toolCallId?: string }
  | { ok: false; message: string } {
  const hasSession = typeof params.sessionId === 'string' && params.sessionId.length > 0;
  const hasRequest =
    (typeof params.requestId === 'string' && params.requestId.length > 0) ||
    typeof params.requestId === 'number';
  if (hasSession === hasRequest) {
    return { ok: false, message: 'exactly one of sessionId or requestId is required' };
  }
  const toolCallId =
    typeof params.toolCallId === 'string' && params.toolCallId.length > 0
      ? params.toolCallId
      : undefined;
  if (toolCallId && !hasSession) {
    return { ok: false, message: 'toolCallId requires sessionId' };
  }
  return {
    ok: true,
    sessionId: hasSession ? (params.sessionId as string) : undefined,
    requestId: hasRequest ? (params.requestId as JsonRpcId) : undefined,
    toolCallId,
  };
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse `elicitation/create` params into form or url (no promptId). */
export function parseElicitationCreate(params: unknown): ParseElicitationResult {
  if (!isRecord(params)) {
    return { kind: 'error', code: -32602, message: 'elicitation params must be an object' };
  }
  const mode = typeof params.mode === 'string' ? params.mode : 'form';
  if (mode !== 'form' && mode !== 'url') {
    return { kind: 'error', code: -32602, message: `unsupported elicitation mode: ${mode}` };
  }

  const scope = parseCreateScope(params);
  if (!scope.ok) {
    return { kind: 'error', code: -32602, message: scope.message };
  }

  const message = typeof params.message === 'string' ? params.message : '';

  if (mode === 'url') {
    const elicitationId =
      typeof params.elicitationId === 'string' ? params.elicitationId.trim() : '';
    const url = typeof params.url === 'string' ? params.url.trim() : '';
    if (!elicitationId) {
      return { kind: 'error', code: -32602, message: 'url elicitation requires elicitationId' };
    }
    if (!url || !isValidUrl(url)) {
      return { kind: 'error', code: -32602, message: 'url elicitation requires a valid http(s) url' };
    }
    return {
      kind: 'url',
      sessionId: scope.sessionId,
      requestId: scope.requestId,
      elicitationId,
      url,
      message,
    };
  }

  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined;
  const properties = schema && isRecord(schema.properties) ? schema.properties : {};
  const requiredList = Array.isArray(schema?.required)
    ? schema!.required.filter((k): k is string => typeof k === 'string')
    : [];
  const required = new Set(requiredList);

  const fields: ElicitationField[] = [];
  for (const key of Object.keys(properties)) {
    if (key.endsWith('_custom')) continue;
    const parsed = parseField(key, properties[key], required);
    if ('error' in parsed) {
      return { kind: 'error', code: -32602, message: parsed.error };
    }
    // Claude companion free-text: mark enum/string fields as allowing Other.
    if (Object.prototype.hasOwnProperty.call(properties, `${key}_custom`)) {
      if (parsed.type === 'enum' || parsed.type === 'string') {
        parsed.allowCustom = true;
      }
    }
    fields.push(parsed);
  }

  if (fields.length === 0) {
    if (!message) {
      return { kind: 'error', code: -32602, message: 'form elicitation requires fields or message' };
    }
    fields.push({ key: 'response', type: 'string', title: message, required: true });
  }

  return {
    kind: 'form',
    sessionId: scope.sessionId,
    requestId: scope.requestId,
    toolCallId: scope.toolCallId,
    message,
    fields,
    required: requiredList,
  };
}

/** Parse -32042 error.data.elicitations entries (no create-scope). */
export function parseUrlElicitationRequiredEntries(
  errorData: unknown,
): { ok: true; entries: ParsedUrlRequiredEntry[] } | { ok: false; message: string } {
  if (!isRecord(errorData)) {
    return { ok: false, message: 'invalid -32042 data' };
  }
  const raw = errorData.elicitations;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'elicitations array required' };
  }
  const entries: ParsedUrlRequiredEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      return { ok: false, message: 'invalid elicitation entry' };
    }
    const mode = typeof item.mode === 'string' ? item.mode : 'url';
    if (mode !== 'url') {
      return { ok: false, message: 'only url elicitations supported in -32042' };
    }
    const elicitationId =
      typeof item.elicitationId === 'string' ? item.elicitationId.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const message = typeof item.message === 'string' ? item.message : '';
    if (!elicitationId || !url || !isValidUrl(url)) {
      return { ok: false, message: 'invalid url elicitation entry' };
    }
    entries.push({ kind: 'urlRequired', elicitationId, url, message });
  }
  return { ok: true, entries };
}

/** True when form is multi-choice / Claude AskUserQuestion shaped. */
export function isAskLikeForm(form: ParsedFormElicitation): boolean {
  if (form.fields.length === 0) return false;
  return form.fields.every((f) => {
    if (f.type === 'enum' || f.type === 'multiEnum') return true;
    if (f.type === 'string' && f.key.startsWith('question_')) return true;
    return false;
  });
}

export function formToAgentQuestions(form: ParsedFormElicitation): AgentQuestion[] {
  return form.fields.map((f) => {
    const prompt = f.description || f.title || form.message || f.key;
    const multiSelect = f.type === 'multiEnum';
    const options = f.options;
    const allowFreeText = !options?.length || f.key.startsWith('question_');
    return {
      prompt,
      options,
      multiSelect,
      allowFreeText: allowFreeText && f.type !== 'multiEnum' ? !options?.length || true : !options?.length,
      fieldKey: f.key,
    };
  });
}

export function encodeFormContent(
  form: ParsedFormElicitation,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = values[field.key];
    if (value === undefined) continue;
    content[field.key] = value;
  }
  return content;
}

export function validateFormValues(
  form: ParsedFormElicitation,
  values: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  for (const field of form.fields) {
    const required = field.required || form.required.includes(field.key);
    const value = values[field.key];
    if (value === undefined || value === null || value === '') {
      if (required) return { ok: false, message: `${field.key} is required` };
      continue;
    }
    switch (field.type) {
      case 'boolean':
        if (typeof value !== 'boolean') return { ok: false, message: `${field.key} must be boolean` };
        break;
      case 'number':
      case 'integer': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          return { ok: false, message: `${field.key} must be a number` };
        }
        if (field.type === 'integer' && !Number.isInteger(value)) {
          return { ok: false, message: `${field.key} must be an integer` };
        }
        if (field.minimum !== undefined && value < field.minimum) {
          return { ok: false, message: `${field.key} below minimum` };
        }
        if (field.maximum !== undefined && value > field.maximum) {
          return { ok: false, message: `${field.key} above maximum` };
        }
        break;
      }
      case 'enum':
        if (typeof value !== 'string' || !field.options?.includes(value)) {
          return { ok: false, message: `${field.key} must be a listed option` };
        }
        break;
      case 'multiEnum': {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
          return { ok: false, message: `${field.key} must be a string array` };
        }
        if (!value.every((v) => field.options?.includes(v))) {
          return { ok: false, message: `${field.key} has invalid options` };
        }
        if (field.minItems !== undefined && value.length < field.minItems) {
          return { ok: false, message: `${field.key} below minItems` };
        }
        if (field.maxItems !== undefined && value.length > field.maxItems) {
          return { ok: false, message: `${field.key} above maxItems` };
        }
        break;
      }
      case 'string': {
        if (typeof value !== 'string') return { ok: false, message: `${field.key} must be a string` };
        if (field.minLength !== undefined && value.length < field.minLength) {
          return { ok: false, message: `${field.key} too short` };
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          return { ok: false, message: `${field.key} too long` };
        }
        if (field.pattern) {
          try {
            if (!new RegExp(field.pattern).test(value)) {
              return { ok: false, message: `${field.key} does not match pattern` };
            }
          } catch {
            return { ok: false, message: `${field.key} has invalid pattern` };
          }
        }
        if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          return { ok: false, message: `${field.key} must be an email` };
        }
        if (field.format === 'uri') {
          try {
            // eslint-disable-next-line no-new
            new URL(value);
          } catch {
            return { ok: false, message: `${field.key} must be a uri` };
          }
        }
        if (field.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return { ok: false, message: `${field.key} must be a date (YYYY-MM-DD)` };
        }
        if (
          field.format === 'date-time' &&
          Number.isNaN(Date.parse(value))
        ) {
          return { ok: false, message: `${field.key} must be a date-time` };
        }
        break;
      }
      default:
        break;
    }
  }
  return { ok: true };
}

/** Normalize Grok ask_user_question items. */
export function normalizeAgentQuestions(raw: unknown): AgentQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentQuestion[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const prompt =
      typeof entry.question === 'string'
        ? entry.question
        : typeof entry.prompt === 'string'
          ? entry.prompt
          : '';
    if (!prompt) continue;
    let options: string[] | undefined;
    if (Array.isArray(entry.options)) {
      options = entry.options
        .map((opt) => {
          if (typeof opt === 'string') return opt;
          if (isRecord(opt) && typeof opt.label === 'string') return opt.label;
          return null;
        })
        .filter((label): label is string => typeof label === 'string' && label.length > 0);
      if (options.length === 0) options = undefined;
    }
    out.push({
      prompt,
      options,
      allowFreeText: !options?.length,
      multiSelect: entry.multiSelect === true,
    });
  }
  return out;
}

export function encodeGrokAnswers(
  questions: AgentQuestion[],
  answers: QuestionAnswers | undefined,
): Record<string, string> {
  const keyed: Record<string, string> = {};
  questions.forEach((q, i) => {
    const entry = answers?.[String(i)];
    const selected = entry?.selected ?? [];
    const free = entry?.freeText?.trim();
    keyed[q.prompt] =
      selected.length > 0 ? selected.join(', ') : free && free.length > 0 ? free : '';
  });
  return keyed;
}

export function encodeElicitationContentFromQuestions(
  questions: AgentQuestion[],
  answers: QuestionAnswers | undefined,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  questions.forEach((q, i) => {
    const key = q.fieldKey ?? `question_${i}`;
    const entry = answers?.[String(i)];
    const selected = entry?.selected ?? [];
    const free = entry?.freeText?.trim() ?? '';
    if (q.multiSelect) {
      content[key] = selected;
    } else if (selected.length > 0) {
      content[key] = selected[0];
    } else if (free && !q.options?.length) {
      content[key] = free;
    }
    if (free && (q.allowFreeText || q.options?.length)) {
      content[`${key}_custom`] = free;
      if (!selected.length && free) content[key] = free;
    }
  });
  return content;
}

export function answersNonEmpty(answers: QuestionAnswers | undefined, count: number): boolean {
  if (!answers) return false;
  for (let i = 0; i < count; i++) {
    const entry = answers[String(i)];
    if (!entry) continue;
    if (entry.selected.length > 0) return true;
    if (entry.freeText && entry.freeText.trim().length > 0) return true;
  }
  return false;
}

export const URL_ELICITATION_REQUIRED_CODE = -32042;
