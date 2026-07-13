export const FILE_DROP_MAX_CANDIDATES = 16;
export const FILE_DROP_MAX_CANDIDATE_LENGTH = 4096;

export interface FileDropFile {
  /** Absolute filesystem path when the host exposes it (Electron `File.path`). */
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

function list<T>(value: ArrayLike<T> | Iterable<T>): T[] {
  return Array.from(value as Iterable<T> | ArrayLike<T>);
}

function uriListCandidates(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function parseJsonArray(value: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resourceUrlCandidates(value: string): string[] {
  const parsed = parseJsonArray(value);
  if (!parsed) return uriListCandidates(value);
  return parsed
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function codeEditorCandidates(value: string): string[] {
  const parsed = parseJsonArray(value);
  if (!parsed) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const resource = (entry as { resource?: unknown }).resource;
    if (typeof resource === 'string' && resource.trim()) {
      out.push(resource.trim());
      continue;
    }
    if (!resource || typeof resource !== 'object') continue;
    const rec = resource as { external?: unknown; fsPath?: unknown; path?: unknown; scheme?: unknown };
    if (typeof rec.external === 'string' && rec.external.trim()) {
      out.push(rec.external.trim());
      continue;
    }
    if (typeof rec.fsPath === 'string' && rec.fsPath.trim()) {
      out.push(rec.fsPath.trim());
      continue;
    }
    if (typeof rec.scheme === 'string' && typeof rec.path === 'string' && rec.path.trim()) {
      out.push(`${rec.scheme}:${rec.path.startsWith('/') ? '' : '//'}${rec.path}`);
    }
  }
  return out;
}

function readType(data: FileDropData, type: string): string {
  try {
    return data.getData(type) || '';
  } catch {
    return '';
  }
}

function looksLikePathOrUri(value: string): boolean {
  const v = value.trim();
  if (!v || v.includes('\0')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return true;
  if (v.startsWith('/') || v.startsWith('\\\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(v)) return true;
  if (
    v.length <= FILE_DROP_MAX_CANDIDATE_LENGTH &&
    /^[A-Za-z0-9_./\\-]+(?:\/[A-Za-z0-9_./\\-]+)+$/.test(v)
  ) {
    return true;
  }
  // bare filename (last-resort OS drop with only File.name)
  if (v.length <= FILE_DROP_MAX_CANDIDATE_LENGTH && /^[^/\\]+$/.test(v) && v.includes('.')) {
    return true;
  }
  return false;
}

function filePathsFromFiles(data: FileDropData): string[] {
  const out: string[] = [];
  for (const file of list(data.files)) {
    if (typeof file.path === 'string' && file.path.trim()) {
      out.push(file.path.trim());
    }
  }
  return out;
}

function fileNamesFromFiles(data: FileDropData): string[] {
  const out: string[] = [];
  for (const file of list(data.files)) {
    if (typeof file.name === 'string' && file.name.trim()) {
      out.push(file.name.trim());
    }
  }
  return out;
}

/**
 * Normalize a browser/Electron DataTransfer into a plain snapshot.
 */
export function dataTransferToFileDropData(dt: DataTransfer): FileDropData {
  const files: FileDropFile[] = [];
  const seenPaths = new Set<string>();

  const pushFile = (file: File | null | undefined) => {
    if (!file) return;
    const withPath = file as File & { path?: string };
    const path =
      typeof withPath.path === 'string' && withPath.path.trim() ? withPath.path.trim() : undefined;
    if (path) {
      if (seenPaths.has(path)) return;
      seenPaths.add(path);
    }
    files.push({ name: file.name, path });
  };

  for (const file of Array.from(dt.files ?? [])) {
    pushFile(file);
  }
  if (dt.items) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind === 'file') {
        pushFile(item.getAsFile() ?? undefined);
      }
    }
  }

  return {
    files,
    types: Array.from(dt.types ?? []),
    getData: (type: string) => {
      try {
        return dt.getData(type) || '';
      } catch {
        return '';
      }
    },
  };
}

/** Read all string DataTransferItems (Finder often only exposes URIs this way). */
export function readDataTransferStringItems(dt: DataTransfer): Promise<string[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const stringItems = items.filter((item) => item.kind === 'string');
  if (stringItems.length === 0) return Promise.resolve([]);

  return Promise.all(
    stringItems.map(
      (item) =>
        new Promise<string>((resolve) => {
          try {
            item.getAsString((value) => resolve(typeof value === 'string' ? value : ''));
          } catch {
            resolve('');
          }
        }),
    ),
  ).then((values) => values.map((v) => v.trim()).filter(Boolean));
}

function candidatesFromType(type: string, value: string): string[] {
  if (!value) return [];
  const lower = type.toLowerCase();
  if (lower === 'text/uri-list' || lower === 'application/vnd.code.uri-list') {
    return uriListCandidates(value).filter(looksLikePathOrUri);
  }
  if (lower === 'resourceurls') {
    return resourceUrlCandidates(value).filter(looksLikePathOrUri);
  }
  if (lower === 'codeeditors') {
    return codeEditorCandidates(value).filter(looksLikePathOrUri);
  }
  if (lower === 'text/plain' || lower === 'text') {
    const lines = uriListCandidates(value).filter(looksLikePathOrUri);
    return lines.length > 0 ? lines : looksLikePathOrUri(value) ? [value.trim()] : [];
  }
  return uriListCandidates(value).filter(looksLikePathOrUri);
}

export function isVsCodeExplorerDrag(types: ArrayLike<string> | Iterable<string>): boolean {
  for (const type of list(types)) {
    const lower = type.toLowerCase();
    if (
      lower === 'resourceurls' ||
      lower === 'codeeditors' ||
      lower === 'application/vnd.code.uri-list'
    ) {
      return true;
    }
  }
  return false;
}

export function isOsFileManagerDrag(types: ArrayLike<string> | Iterable<string>): boolean {
  const listTypes = list(types);
  if (isVsCodeExplorerDrag(listTypes)) return false;
  return listTypes.some((type) => type === 'Files' || type.toLowerCase() === 'files');
}

function extractFromPreferredSource(data: FileDropData): string[] {
  const advertised = list(data.types);
  const advertisedLower = new Set(advertised.map((type) => type.toLowerCase()));

  const tryTypes = (types: string[]): string[] => {
    for (const type of types) {
      const found = candidatesFromType(type, readType(data, type));
      if (found.length > 0) return found;
    }
    return [];
  };

  const fromExplorer = tryTypes([
    'resourceurls',
    'ResourceURLs',
    'codeeditors',
    'CodeEditors',
    'application/vnd.code.uri-list',
  ]);
  if (fromExplorer.length > 0) return fromExplorer;

  const fromUriList = tryTypes(['text/uri-list', 'text/URI-list']);
  if (fromUriList.length > 0) return fromUriList;

  const fromFiles = filePathsFromFiles(data);
  if (fromFiles.length > 0) return fromFiles;

  for (const type of advertised) {
    const lower = type.toLowerCase();
    if (
      lower === 'resourceurls' ||
      lower === 'codeeditors' ||
      lower === 'text/uri-list' ||
      lower === 'files' ||
      lower === 'text/plain' ||
      lower === 'text'
    ) {
      continue;
    }
    const found = candidatesFromType(type, readType(data, type));
    if (found.length > 0) return found;
  }

  if (advertisedLower.has('text/plain') || advertisedLower.has('text')) {
    const fromPlain = tryTypes(['text/plain', 'text']);
    if (fromPlain.length > 0) return fromPlain;
  }

  if (advertised.length === 0 || advertisedLower.has('files')) {
    const probed = tryTypes(['text/uri-list']);
    if (probed.length > 0) return probed;
  }

  // Last resort: bare file names when the webview sandbox strips absolute paths.
  return fileNamesFromFiles(data);
}

export function extractFileDropCandidates(data: FileDropData, enabled: boolean): FileDropExtractionResult {
  if (!enabled) {
    return { ok: false, code: 'disabled', message: 'File drop is unavailable.' };
  }

  const unique = [...new Set(extractFromPreferredSource(data))];
  if (unique.length === 0) {
    return {
      ok: false,
      code: 'noData',
      message: 'No file path in this drop. Hold Shift, or use Add Context (+).',
    };
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

/**
 * Full drop extraction: sync MIME/File.path first, then async string items
 * (macOS Finder often only fills text/uri-list via getAsString).
 */
export async function extractFileDropCandidatesFromDataTransfer(
  dt: DataTransfer,
  enabled: boolean,
): Promise<FileDropExtractionResult> {
  if (!enabled) {
    return { ok: false, code: 'disabled', message: 'File drop is unavailable.' };
  }

  const snap = dataTransferToFileDropData(dt);
  let result = extractFileDropCandidates(snap, enabled);
  if (result.ok) return result;

  const asyncStrings = await readDataTransferStringItems(dt);
  if (asyncStrings.length === 0) return result;

  const blob = asyncStrings.join('\n');
  const enriched: FileDropData = {
    files: snap.files,
    types: [...new Set([...list(snap.types), 'text/uri-list', 'text/plain'])],
    getData: (type: string) => {
      const lower = type.toLowerCase();
      if (lower === 'text/uri-list' || lower === 'text/plain' || lower === 'text') {
        return blob || snap.getData(type);
      }
      return snap.getData(type);
    },
  };
  return extractFileDropCandidates(enriched, enabled);
}
