import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BACKEND_READINESS_IDS,
  type BackendReadinessId,
} from '../shared/backend-readiness';

/**
 * Allowlisted provider registry: one ordered entry per readiness backend.
 * Command resolution stays host-only; absolute paths never cross into snapshots.
 */
export interface BackendProviderEntry {
  id: BackendReadinessId;
  /** Human label (not used in readiness snapshot). */
  label: string;
  /** Resolve the PATH command / override env for passive inventory. */
  resolveCommand: () => string;
}

/**
 * Single allowlisted provider registry. Order matches BACKEND_READINESS_IDS.
 * Claude/Codex honor existing env overrides used by their ACP adapters.
 */
export const BACKEND_PROVIDER_REGISTRY: readonly BackendProviderEntry[] = [
  {
    id: 'claude',
    label: 'Claude',
    resolveCommand: () => process.env.CLAUDE_CODE_EXECUTABLE || 'claude',
  },
  {
    id: 'grok',
    label: 'Grok',
    resolveCommand: () => 'grok',
  },
  {
    id: 'kiro',
    label: 'Kiro',
    resolveCommand: () => 'kiro-cli',
  },
  {
    id: 'codex',
    label: 'Codex',
    resolveCommand: () => process.env.CODEX_PATH || 'codex',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    resolveCommand: () => 'opencode',
  },
];

const REGISTRY_BY_ID = new Map(BACKEND_PROVIDER_REGISTRY.map((e) => [e.id, e]));

/** Resolve the inventory command for a backend ID. */
export function resolveBackendCommand(id: BackendReadinessId): string {
  const entry = REGISTRY_BY_ID.get(id);
  if (!entry) {
    throw new Error(`unknown backend id: ${id}`);
  }
  return entry.resolveCommand();
}

/**
 * Query the login shell's PATH. GUI-launched editors (Finder/Dock on macOS)
 * inherit a minimal PATH; the login shell has the user's real PATH. Interactive
 * rc files may echo to stdout, so fence the value with markers and extract only
 * what is between them.
 */
async function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return '';
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise<string>((resolve) => {
    try {
      execFile(
        shell,
        ['-lic', 'printf "__MUSTER_PATH[%s]MUSTER_PATH__" "$PATH"'],
        { timeout: 2500 },
        (err, stdout) => {
          if (err) return resolve('');
          const fenced = /__MUSTER_PATH\[([\s\S]*)\]MUSTER_PATH__/.exec(String(stdout));
          resolve(fenced ? fenced[1] : '');
        },
      );
    } catch {
      resolve('');
    }
  });
}

function commonBinDirs(): string[] {
  if (process.platform === 'win32') return [];
  const home = os.homedir();
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
  ];
}

/**
 * `process.env.PATH` unioned (existing entries first) with the login-shell PATH
 * and common install dirs.
 */
export async function resolveAugmentedPath(): Promise<string> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (value?: string | null): void => {
    if (!value) return;
    for (const dir of value.split(path.delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
    }
  };
  add(process.env.PATH);
  add(await loginShellPath());
  for (const dir of commonBinDirs()) add(dir);
  return dirs.join(path.delimiter);
}

/**
 * Patch this process's PATH with {@link resolveAugmentedPath} so that BOTH
 * availability detection AND the actual backend child-process spawns (which
 * inherit `process.env`) resolve the same CLIs. Without this, a GUI-launched
 * editor could detect a CLI on the augmented PATH yet fail to spawn it on the
 * minimal `process.env.PATH`. Call once, early in activation.
 */
export async function installAugmentedPath(): Promise<void> {
  process.env.PATH = await resolveAugmentedPath();
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True if `command` resolves to an executable file via the given search dirs. */
export function commandResolves(command: string, dirs: string[]): boolean {
  if (command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command);
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isExecutableFile(path.join(dir, command + ext))) return true;
    }
  }
  return false;
}

/**
 * Detect which backends have their underlying CLI installed and callable on
 * this machine. Reads `process.env.PATH`, which {@link installAugmentedPath}
 * has patched at activation to the same PATH the backend spawns will use — so
 * "detected available" matches "actually callable".
 *
 * Returns IDs in registry / readiness order (subset of BACKEND_READINESS_IDS).
 */
export async function detectAvailableBackends(): Promise<string[]> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const available: string[] = [];
  for (const entry of BACKEND_PROVIDER_REGISTRY) {
    if (commandResolves(entry.resolveCommand(), dirs)) available.push(entry.id);
  }
  // Defensive: registry order must stay aligned with the shared allowlist.
  void BACKEND_READINESS_IDS;
  return available;
}
