/**
 * Host-side on-disk skill discovery for the composer skill picker.
 *
 * The ACP `available_commands_update` a backend advertises is (a) only populated
 * after a session has run and (b) the whole slash-command set (built-ins + custom
 * commands + skills), not a skills-only list. For a picker that works cold and
 * lists only real skills we scan the on-disk skill directories directly.
 *
 * A skill is a subdirectory containing a `SKILL.md` (the cross-agent SKILL.md
 * contract). The directory name is the invocation name (`/name` or `$name`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { SKILL_NAME_RE } from '../task/brief';

/**
 * Per-backend skill directories, relative to the workspace cwd and to $HOME.
 * `.agents/skills` is the cross-agent SKILL.md location honored by several CLIs.
 */
const BACKEND_SKILL_DIRS: Readonly<
  Record<string, { workspace: readonly string[]; home: readonly string[] }>
> = {
  claude: { workspace: ['.claude/skills'], home: ['.claude/skills'] },
  codex: {
    workspace: ['.codex/skills', '.agents/skills'],
    home: ['.codex/skills', '.agents/skills'],
  },
  opencode: { workspace: ['.opencode/skills', '.agents/skills'], home: ['.config/opencode/skills'] },
  grok: { workspace: ['.agents/skills'], home: [] },
  kiro: { workspace: ['.agents/skills'], home: [] },
};

/** Sanity cap so a pathological skills dir can't flood the picker. */
export const MAX_DISCOVERED_SKILLS = 200;

interface SkillFsLike {
  readdirSync: typeof fs.readdirSync;
  statSync: typeof fs.statSync;
}

/**
 * Discover skill names for `backend` by scanning its on-disk skill directories
 * under `cwd` (workspace) and `homeDir`. Each skill is a subdirectory (or a
 * symlink to one) containing a `SKILL.md`. Only names matching SKILL_NAME_RE
 * (i.e. injectable) are returned, deduped and sorted. Never throws — a missing
 * or unreadable directory is skipped.
 */
export function discoverSkillNames(
  backend: string,
  cwd: string | undefined,
  homeDir: string | undefined,
  fsImpl: SkillFsLike = fs,
): string[] {
  // Own-property check: a bracket lookup would otherwise resolve inherited names
  // like `constructor`/`toString`/`__proto__` to Object.prototype members.
  if (!Object.hasOwn(BACKEND_SKILL_DIRS, backend)) return [];
  const dirs = BACKEND_SKILL_DIRS[backend];

  const roots: string[] = [];
  if (cwd) for (const d of dirs.workspace) roots.push(path.join(cwd, d));
  if (homeDir) for (const d of dirs.home) roots.push(path.join(homeDir, d));

  const names = new Set<string>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true }) as fs.Dirent[];
    } catch {
      continue; // missing / unreadable directory → skip
    }
    for (const entry of entries) {
      const name = entry.name;
      // Only names that can actually be injected as `<prefix>name`.
      if (!SKILL_NAME_RE.test(name)) continue;
      // A skill directory, or a symlink resolving to one (skips .DS_Store etc.).
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = fsImpl.statSync(path.join(root, name)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      // Require the SKILL.md contract file (statSync follows a symlinked skill).
      try {
        if (!fsImpl.statSync(path.join(root, name, 'SKILL.md')).isFile()) continue;
      } catch {
        continue;
      }
      names.add(name);
      if (names.size >= MAX_DISCOVERED_SKILLS) break;
    }
    if (names.size >= MAX_DISCOVERED_SKILLS) break;
  }
  return [...names].sort();
}
