export const FILE_DROP_MAX_CANDIDATES = 16;
export const FILE_DROP_MAX_CANDIDATE_LENGTH = 4096;

export interface FileDropFile {
  path?: string;
  name?: string;
}

export interface FileDropData {
  files: ArrayLike<FileDropFile> | Iterable<FileDropFile>;
  types: ArrayLike<string> | Iterable<string>;
  getData(type: string): string;
}

export type FileDropExtractionResult =
  | { ok: true; candidates: string[] }
  | {
      ok: false;
      code: 'disabled' | 'noData' | 'tooManyCandidates' | 'invalidCandidate';
      message: string;
    };

const SUPPORTED_TEXT_TYPES = ['text/uri-list', 'text/plain'] as const;

function list<T>(value: ArrayLike<T> | Iterable<T>): T[] {
  return Array.from(value as Iterable<T> | ArrayLike<T>);
}

function uriListCandidates(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function extractFileDropCandidates(data: FileDropData, enabled: boolean): FileDropExtractionResult {
  if (!enabled) {
    return { ok: false, code: 'disabled', message: 'File drop is unavailable.' };
  }

  const candidates: string[] = [];
  for (const file of list(data.files)) {
    if (typeof file.path === 'string' && file.path.trim()) candidates.push(file.path.trim());
  }

  const advertisedTypes = new Set(list(data.types));
  for (const type of SUPPORTED_TEXT_TYPES) {
    if (!advertisedTypes.has(type)) continue;
    const value = data.getData(type);
    if (!value) continue;
    if (type === 'text/uri-list') candidates.push(...uriListCandidates(value));
    else if (value.trim()) candidates.push(value.trim());
  }

  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    return { ok: false, code: 'noData', message: 'No supported file data was dropped.' };
  }
  if (unique.length > FILE_DROP_MAX_CANDIDATES) {
    return {
      ok: false,
      code: 'tooManyCandidates',
      message: `Drop at most ${FILE_DROP_MAX_CANDIDATES} file candidates.`,
    };
  }
  if (unique.some((candidate) => candidate.length > FILE_DROP_MAX_CANDIDATE_LENGTH || candidate.includes('\0'))) {
    return {
      ok: false,
      code: 'invalidCandidate',
      message: 'Dropped file data is malformed or too long.',
    };
  }

  return { ok: true, candidates: unique };
}
