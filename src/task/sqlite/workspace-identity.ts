/**
 * Workspace identity resolution (plan §3.3).
 *
 * `workspace_id` is a Muster-generated UUID, never a folder name. Identity and
 * location are separate so a workspace can be moved/renamed and still relink to
 * the same data. This module computes the stable `identity_key` used for lookup;
 * the UUID and location aliases are assigned by the registry (Phase 1 continued).
 *
 * Pure + host-agnostic: it takes already-resolved URI strings so it can be unit
 * tested without VS Code. The extension host adapts `vscode.workspace` into
 * {@link WorkspaceContext} at activation.
 */
import { createHash } from 'node:crypto';

/**
 * Normalized description of the current window's workspace, derived from VS Code
 * at the host boundary. All URIs are canonical `.toString()` forms.
 */
export type WorkspaceContext =
  | { kind: 'single-root'; folderUri: string }
  | { kind: 'multi-root'; workspaceFileUri?: string; folderUris: string[] }
  | { kind: 'empty'; profileAuthority: string };

/**
 * Stable lookup key for a workspace. Distinct from the UUID primary key: the same
 * physical workspace always hashes to the same key so re-opening relinks to its
 * existing UUID + data.
 */
export interface WorkspaceIdentity {
  identityKey: string;
  /** Canonical URIs observed for this workspace (recorded in workspace_locations). */
  locations: string[];
  /** Best-effort human label for `workspaces.display_name`. */
  displayName: string;
}

function digest(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

function basename(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '');
  const seg = trimmed.split('/').pop() ?? trimmed;
  try {
    return decodeURIComponent(seg) || uri;
  } catch {
    return seg || uri;
  }
}

/**
 * Compute the identity key + candidate locations for a workspace context.
 *
 * - single-root: keyed by the folder URI.
 * - multi-root: keyed by the `.code-workspace` file URI when present; otherwise a
 *   stable digest of the normalized + sorted folder URI list (so folder reordering
 *   does not fork identity).
 * - empty window: a FIXED logical id `empty:<profile/authority>` — never a fresh
 *   UUID per activation (plan §3.3), so an empty window relinks to the same store.
 */
export function resolveWorkspaceIdentity(ctx: WorkspaceContext): WorkspaceIdentity {
  switch (ctx.kind) {
    case 'single-root': {
      return {
        identityKey: `single:${ctx.folderUri}`,
        locations: [ctx.folderUri],
        displayName: basename(ctx.folderUri),
      };
    }
    case 'multi-root': {
      if (ctx.workspaceFileUri) {
        return {
          identityKey: `multi-file:${ctx.workspaceFileUri}`,
          locations: [ctx.workspaceFileUri, ...ctx.folderUris],
          displayName: basename(ctx.workspaceFileUri),
        };
      }
      const sorted = [...ctx.folderUris].sort();
      return {
        identityKey: `multi-folders:${digest(sorted)}`,
        locations: sorted,
        displayName:
          sorted.length > 0
            ? `${basename(sorted[0]!)} +${sorted.length - 1}`
            : 'Untitled (multi-root)',
      };
    }
    case 'empty': {
      return {
        identityKey: `empty:${ctx.profileAuthority}`,
        locations: [],
        displayName: 'No folder',
      };
    }
    default: {
      const _exhaustive: never = ctx;
      return _exhaustive;
    }
  }
}
