import * as path from 'path';

export interface FileMentionUri {
  scheme: string;
  path: string;
  fsPath: string;
}
export interface FileMentionWorkspaceFolder { uri: FileMentionUri }
export interface FileMentionServices {
  workspaceFolders: readonly FileMentionWorkspaceFolder[] | undefined;
  parseUri(value: string): FileMentionUri;
  fileUri(value: string): FileMentionUri;
  joinPath(base: FileMentionUri, value: string): FileMentionUri;
  stat(uri: FileMentionUri): PromiseLike<{ type: number }>;
}
export type FileMentionErrorCode = 'invalidPayload' | 'tooManyCandidates' | 'multipleFiles' | 'malformedCandidate' | 'unsupportedScheme' | 'noWorkspace' | 'outsideWorkspace' | 'notFile' | 'unavailable';
export type FileMentionResult = { ok: true; path: string } | { ok: false; code: FileMentionErrorCode; message: string };
const MAX_CANDIDATES = 16;
const MAX_LENGTH = 4096;
const FILE_TYPE = 1;
const messages: Record<FileMentionErrorCode, string> = {
  invalidPayload: 'File drop did not include a valid file reference.',
  tooManyCandidates: 'Too many file references were dropped.',
  multipleFiles: 'Drop one file at a time.',
  malformedCandidate: 'Dropped file data is malformed.',
  unsupportedScheme: 'This file location is not supported.',
  noWorkspace: 'Open a workspace before dropping a file.',
  outsideWorkspace: 'Drop a file from the current workspace.',
  notFile: 'Only regular workspace files can be dropped.',
  unavailable: 'Unable to read the dropped file.',
};
const fail = (code: FileMentionErrorCode): FileMentionResult => ({ ok: false, code, message: messages[code] });

function relativeMention(uri: FileMentionUri, folder: FileMentionWorkspaceFolder): string | undefined {
  if (uri.scheme !== folder.uri.scheme) return undefined;
  const remote = uri.scheme !== 'file';
  const relative = remote
    ? path.posix.relative(folder.uri.path, uri.path)
    : path.relative(folder.uri.fsPath, uri.fsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
  return relative.replace(/\\/g, '/');
}

export async function resolveDroppedFileMention(input: unknown, services: FileMentionServices): Promise<FileMentionResult> {
  if (!Array.isArray(input) || !input.every((value) => typeof value === 'string')) return fail('invalidPayload');
  if (input.length > MAX_CANDIDATES) return fail('tooManyCandidates');
  if (input.some((value) => value.length > MAX_LENGTH || value.includes('\0'))) return fail('malformedCandidate');
  const candidates = [...new Set(input.flatMap((value) => value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))))];
  if (!candidates.length) return fail('invalidPayload');
  if (candidates.length > MAX_CANDIDATES) return fail('tooManyCandidates');
  if (candidates.length !== 1) return fail('multipleFiles');
  const candidate = candidates[0];
  if (candidate.length > MAX_LENGTH || candidate.includes('\0')) return fail('malformedCandidate');
  const folders = services.workspaceFolders ?? [];
  if (!folders.length) return fail('noWorkspace');
  let uri: FileMentionUri;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      uri = services.parseUri(candidate);
      if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') return fail('unsupportedScheme');
    } else if (path.isAbsolute(candidate) || /^[a-z]:[\\/]/i.test(candidate)) {
      uri = services.fileUri(candidate);
    } else {
      uri = services.joinPath(folders[0].uri, decodeURIComponent(candidate));
    }
  } catch { return fail('malformedCandidate'); }
  const mention = folders.map((folder) => relativeMention(uri, folder)).find(Boolean);
  if (!mention) return fail('outsideWorkspace');
  try {
    const stat = await services.stat(uri);
    if ((stat.type & FILE_TYPE) !== FILE_TYPE) return fail('notFile');
  } catch { return fail('unavailable'); }
  return { ok: true, path: mention };
}
