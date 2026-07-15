/**
 * Pure helpers: workspace markdown paths → presentation panel identity.
 * Host resolves and reads the file; webview only forwards the raw href.
 */

import { createHash } from 'crypto';
import * as path from 'path';
import {
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from '../task/coordinator-tools';

const MD_EXT = /\.(md|markdown|mdx)$/i;
/** presentationId must match PresentationManager / upsert stable-id rules. */
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type MarkdownFileOpenTarget = {
  /** Absolute filesystem path (posix or platform). */
  absolutePath: string;
  presentationId: string;
  title: string;
  /** Workspace-relative posix path. */
  sourcePath: string;
  /** vscode.Uri.toString() of the workspace folder that owns the file. */
  sourceFolderUri: string;
};

export type WorkspaceFolderRoot = {
  fsPath: string;
  /** Stable folder identity, e.g. Uri.toString(). */
  uri: string;
};

/**
 * True when `href` is a workspace-relative or file: path that points at markdown.
 * Rejects http(s)/mailto/javascript and other schemes.
 */
export function isWorkspaceMarkdownHref(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^file:/i.test(trimmed)) return false;
  const pathPart = stripQueryHash(fileUrlToPath(trimmed));
  if (!pathPart || pathPart.includes('\0')) return false;
  return MD_EXT.test(pathPart);
}

/** Basename without extension, clamped for presentation title. */
export function titleFromMarkdownPath(absoluteOrRelative: string): string {
  const base = stripQueryHash(fileUrlToPath(absoluteOrRelative)).replace(/\\/g, '/');
  const name = base.split('/').pop() || 'plan';
  const withoutExt = name.replace(MD_EXT, '') || name;
  const title = withoutExt.trim() || 'Markdown';
  return title.length <= PRESENTATION_TITLE_MAX_LENGTH
    ? title
    : title.slice(0, PRESENTATION_TITLE_MAX_LENGTH);
}

function shortHash(input: string, bytes = 10): string {
  return createHash('sha256').update(input).digest('base64url').slice(0, bytes);
}

/**
 * Collision-safe presentation id from folder URI + workspace-relative path.
 * Example: md.a1b2c3d4e5.f6g7h8i9j0
 */
export function presentationIdFromFolderAndRelativePath(
  folderUri: string,
  relativePath: string,
): string {
  const posix = stripQueryHash(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  const folderKey = shortHash(folderUri, 10);
  const pathKey = shortHash(posix || 'file', 10);
  let id = `md.${folderKey}.${pathKey}`;
  if (id.length > PRESENTATION_ID_MAX_LENGTH) {
    id = id.slice(0, PRESENTATION_ID_MAX_LENGTH);
  }
  if (!STABLE_ID_PATTERN.test(id)) {
    id = `md.${folderKey}.file`;
  }
  return id;
}

/**
 * @deprecated Prefer presentationIdFromFolderAndRelativePath — slug collides for a-b vs a/b.
 * Kept for tests that assert legacy behavior during migration windows.
 */
export function presentationIdFromRelativePath(relativePath: string): string {
  const posix = stripQueryHash(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  const cleaned = posix
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  let id = `md:${cleaned || 'file'}`;
  if (id.length > PRESENTATION_ID_MAX_LENGTH) {
    id = id.slice(0, PRESENTATION_ID_MAX_LENGTH);
  }
  if (!STABLE_ID_PATTERN.test(id)) {
    id = 'md:file';
  }
  return id;
}

/**
 * Resolve a raw webview href to an absolute path under one of `workspaceRoots`.
 * `workspaceRoots` may be plain fs paths (legacy) or `{ fsPath, uri }` for multi-root identity.
 */
export function resolveWorkspaceMarkdownPath(
  raw: string,
  workspaceRoots: readonly (string | WorkspaceFolderRoot)[],
): MarkdownFileOpenTarget | undefined {
  if (!isWorkspaceMarkdownHref(raw) || workspaceRoots.length === 0) return undefined;

  const asPath = stripQueryHash(fileUrlToPath(raw.trim()));
  if (!asPath) return undefined;

  const isAbs =
    asPath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(asPath) ||
    asPath.startsWith('\\\\');

  for (const root of workspaceRoots) {
    if (!root) continue;
    const fsPath = typeof root === 'string' ? root : root.fsPath;
    const folderUri = typeof root === 'string' ? `file://${normalizeFsPath(root)}` : root.uri;
    if (!fsPath) continue;
    const rootNorm = normalizeFsPath(fsPath);
    const candidate = isAbs
      ? normalizeFsPath(asPath)
      : normalizeFsPath(joinFs(rootNorm, asPath));
    if (!isPathInsideRoot(candidate, rootNorm)) continue;
    if (!MD_EXT.test(candidate)) continue;

    const rel = relativeToRoot(candidate, rootNorm).replace(/\\/g, '/');
    return {
      absolutePath: candidate,
      presentationId: presentationIdFromFolderAndRelativePath(folderUri, rel),
      title: titleFromMarkdownPath(candidate),
      sourcePath: rel,
      sourceFolderUri: folderUri,
    };
  }
  return undefined;
}

export function clampPresentationMarkdown(text: string): string {
  if (text.length <= PRESENTATION_MARKDOWN_MAX_LENGTH) return text;
  return text.slice(0, PRESENTATION_MARKDOWN_MAX_LENGTH);
}

/** Split href into path + fragment (without #). */
export function splitMarkdownHref(raw: string): { path: string; fragment?: string } {
  const trimmed = raw.trim();
  const hash = trimmed.indexOf('#');
  if (hash < 0) return { path: trimmed };
  const pathPart = trimmed.slice(0, hash);
  const fragment = trimmed.slice(hash + 1);
  if (!fragment || !/^[A-Za-z0-9._:-]+$/.test(fragment)) return { path: pathPart };
  return { path: pathPart, fragment };
}

/**
 * Resolve absolute path under a bound folder + relative source path.
 * Webview href protocol: leading `/` = workspace-root-relative (not OS-absolute).
 * OS-absolute only for `file:` URLs or Windows drive paths.
 */
export function resolveUnderSource(
  hrefPath: string,
  sourcePath: string | undefined,
  _sourceFolderUri: string,
  folderFsPath: string,
): { absolutePath: string; relativePath: string } | undefined {
  const trimmed = hrefPath.trim();
  if (!trimmed) return undefined;
  const rootNorm = normalizeFsPath(folderFsPath);
  const isFileUrl = /^file:/i.test(trimmed);
  const asPath = stripQueryHash(fileUrlToPath(trimmed));
  if (!asPath) return undefined;

  const isOsAbs =
    isFileUrl ||
    /^[A-Za-z]:[\\/]/.test(asPath) ||
    asPath.startsWith('\\\\');

  let candidate: string;
  if (isOsAbs) {
    candidate = normalizeFsPath(asPath);
  } else if (asPath.startsWith('/')) {
    // Workspace-root-relative (e.g. /docs/plan.md)
    candidate = normalizeFsPath(joinFs(rootNorm, asPath.replace(/^\/+/, '')));
  } else if (sourcePath) {
    const dir = sourcePath.includes('/')
      ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
      : '';
    const base = dir ? joinFs(rootNorm, dir) : rootNorm;
    candidate = normalizeFsPath(joinFs(base, asPath));
  } else {
    candidate = normalizeFsPath(joinFs(rootNorm, asPath));
  }
  if (!isPathInsideRoot(candidate, rootNorm)) return undefined;
  if (!MD_EXT.test(candidate)) return undefined;
  const relativePath = relativeToRoot(candidate, rootNorm).replace(/\\/g, '/');
  return { absolutePath: candidate, relativePath };
}

/** True when realFile is inside realRoot after realpath (platform-aware). */
export function isCanonicalInsideRoot(realFile: string, realRoot: string): boolean {
  const rel = path.relative(realRoot, realFile);
  if (!rel || rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

function stripQueryHash(value: string): string {
  const q = value.indexOf('?');
  const h = value.indexOf('#');
  let end = value.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return value.slice(0, end);
}

/** Minimal file: URL → path (no full URL parser dependency). */
function fileUrlToPath(raw: string): string {
  if (!/^file:/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'file:') return raw;
    let p = decodeURIComponent(u.pathname);
    // Windows file:///C:/... → /C:/... → C:/...
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  } catch {
    return raw.replace(/^file:\/\//i, '');
  }
}

function normalizeFsPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  // Collapse . and .. carefully for containment checks only.
  const parts: string[] = [];
  const abs = s.startsWith('/');
  const drive = /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : '';
  if (drive) s = s.slice(2);
  if (s.startsWith('/')) s = s.slice(1);
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const body = parts.join('/');
  if (drive) return `${drive}/${body}`;
  return abs ? `/${body}` : body;
}

function joinFs(root: string, rel: string): string {
  const r = root.replace(/\/+$/, '');
  const relNorm = rel.replace(/^\/+/, '');
  return `${r}/${relNorm}`;
}

function isPathInsideRoot(absolute: string, root: string): boolean {
  const a = normalizeFsPath(absolute).toLowerCase();
  const r = normalizeFsPath(root).toLowerCase().replace(/\/+$/, '');
  return a === r || a.startsWith(`${r}/`);
}

function relativeToRoot(absolute: string, root: string): string {
  const a = normalizeFsPath(absolute);
  const r = normalizeFsPath(root).replace(/\/+$/, '');
  if (a === r) return a.split('/').pop() || 'file.md';
  if (a.startsWith(`${r}/`)) return a.slice(r.length + 1);
  return a.split('/').pop() || 'file.md';
}
