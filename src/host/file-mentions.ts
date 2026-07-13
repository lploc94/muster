import * as path from 'path';

export interface FileMentionUri {
  scheme: string;
  path: string;
  fsPath: string;
}
export interface FileMentionWorkspaceFolder {
  uri: FileMentionUri;
}
export interface FileMentionServices {
  workspaceFolders: readonly FileMentionWorkspaceFolder[] | undefined;
  parseUri(value: string): FileMentionUri;
  fileUri(value: string): FileMentionUri;
  joinPath(base: FileMentionUri, value: string): FileMentionUri;
  stat(uri: FileMentionUri): PromiseLike<{ type: number }>;
}
export type FileMentionErrorCode =
  | 'invalidPayload'
  | 'tooManyCandidates'
  | 'multipleFiles'
  | 'malformedCandidate'
  | 'unsupportedScheme'
  | 'notFile'
  | 'unavailable';
export type FileMentionResult =
  | { ok: true; path: string }
  | { ok: false; code: FileMentionErrorCode; message: string };

const MAX_CANDIDATES = 16;
const MAX_LENGTH = 4096;
const FILE_TYPE = 1;
const DIRECTORY_TYPE = 2;
const messages: Record<FileMentionErrorCode, string> = {
  invalidPayload: 'File drop did not include a valid file reference.',
  tooManyCandidates: 'Too many file references were dropped.',
  multipleFiles: 'Drop one file at a time.',
  malformedCandidate: 'Dropped file data is malformed.',
  unsupportedScheme: 'This file location is not supported.',
  notFile: 'Only files can be dropped (not folders).',
  unavailable: 'Unable to read the dropped file.',
};
const fail = (code: FileMentionErrorCode): FileMentionResult => ({
  ok: false,
  code,
  message: messages[code],
});

/** Prefer workspace-relative; otherwise absolute fsPath / URI path (any location). */
function mentionForUri(
  uri: FileMentionUri,
  folders: readonly FileMentionWorkspaceFolder[],
): string {
  for (const folder of folders) {
    if (uri.scheme !== folder.uri.scheme) continue;
    const remote = uri.scheme !== 'file';
    const relative = remote
      ? path.posix.relative(folder.uri.path, uri.path)
      : path.relative(folder.uri.fsPath, uri.fsPath);
    if (
      relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !relative.startsWith('../') &&
      !path.isAbsolute(relative)
    ) {
      return relative.replace(/\\/g, '/');
    }
  }
  if (uri.scheme === 'file' && uri.fsPath) {
    return uri.fsPath.replace(/\\/g, '/');
  }
  return uri.path || uri.fsPath;
}

function expandInputCandidates(input: string[]): string[] {
  return [
    ...new Set(
      input.flatMap((value) =>
        value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#')),
      ),
    ),
  ];
}

function parseCandidateUri(
  candidate: string,
  folders: readonly FileMentionWorkspaceFolder[],
  services: FileMentionServices,
): { ok: true; uri: FileMentionUri } | { ok: false; code: FileMentionErrorCode } {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      const uri = services.parseUri(candidate);
      // Accept file and vscode-remote; other schemes rejected.
      if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
        return { ok: false, code: 'unsupportedScheme' };
      }
      return { ok: true, uri };
    }
    if (path.isAbsolute(candidate) || /^[a-z]:[\\/]/i.test(candidate)) {
      return { ok: true, uri: services.fileUri(candidate) };
    }
    // Relative — join first workspace folder when available; else treat as opaque path string via file URI of cwd-style.
    if (folders.length > 0) {
      return { ok: true, uri: services.joinPath(folders[0].uri, decodeURIComponent(candidate)) };
    }
    // No workspace: still accept relative-looking strings as file URIs under /
    return { ok: true, uri: services.fileUri(path.resolve(candidate)) };
  } catch {
    return { ok: false, code: 'malformedCandidate' };
  }
}

/**
 * Collapse alternate encodings of the same file into one mention path.
 * Mentions may be workspace-relative or absolute — outside workspace is allowed.
 */
function collapseToUniqueMentions(
  candidates: string[],
  folders: readonly FileMentionWorkspaceFolder[],
  services: FileMentionServices,
):
  | { ok: true; mention: string; uri: FileMentionUri }
  | { ok: false; code: FileMentionErrorCode } {
  const byMention = new Map<string, FileMentionUri>();
  let lastError: FileMentionErrorCode = 'invalidPayload';

  for (const candidate of candidates) {
    if (candidate.length > MAX_LENGTH || candidate.includes('\0')) {
      lastError = 'malformedCandidate';
      continue;
    }
    const parsed = parseCandidateUri(candidate, folders, services);
    if (!parsed.ok) {
      lastError = parsed.code;
      continue;
    }
    const mention = mentionForUri(parsed.uri, folders);
    if (!mention) {
      lastError = 'malformedCandidate';
      continue;
    }
    if (!byMention.has(mention)) {
      byMention.set(mention, parsed.uri);
    }
  }

  if (byMention.size === 0) return { ok: false, code: lastError };
  if (byMention.size > 1) return { ok: false, code: 'multipleFiles' };
  const [mention, uri] = [...byMention.entries()][0];
  return { ok: true, mention, uri };
}

export async function resolveDroppedFileMention(
  input: unknown,
  services: FileMentionServices,
): Promise<FileMentionResult> {
  if (!Array.isArray(input) || !input.every((value) => typeof value === 'string')) {
    return fail('invalidPayload');
  }
  if (input.length > MAX_CANDIDATES) return fail('tooManyCandidates');
  if (input.some((value) => value.length > MAX_LENGTH || value.includes('\0'))) {
    return fail('malformedCandidate');
  }

  const candidates = expandInputCandidates(input);
  if (!candidates.length) return fail('invalidPayload');
  if (candidates.length > MAX_CANDIDATES) return fail('tooManyCandidates');

  const folders = services.workspaceFolders ?? [];
  const collapsed = collapseToUniqueMentions(candidates, folders, services);
  if (!collapsed.ok) return fail(collapsed.code);

  // Best-effort type check: reject directories when stat works. Missing files still OK.
  try {
    const stat = await services.stat(collapsed.uri);
    if ((stat.type & DIRECTORY_TYPE) === DIRECTORY_TYPE && (stat.type & FILE_TYPE) !== FILE_TYPE) {
      return fail('notFile');
    }
  } catch {
    // Path may be outside the sandbox or not yet written — still mention it.
  }

  return { ok: true, path: collapsed.mention };
}
