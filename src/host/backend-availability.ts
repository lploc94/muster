import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The underlying CLI each backend needs on PATH to be usable. Claude and Codex
 * run a bundled ACP adapter that shells out to the user's installed `claude` /
 * `codex` (overridable via env); the other three are plain commands.
 */
const BACKEND_COMMAND: Record<string, () => string> = {
  claude: () => process.env.CLAUDE_CODE_EXECUTABLE || 'claude',
  codex: () => process.env.CODEX_PATH || 'codex',
  grok: () => 'grok',
  kiro: () => 'kiro-cli',
  opencode: () => 'opencode',
};

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
 */
export async function detectAvailableBackends(): Promise<string[]> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const available: string[] = [];
  for (const [id, command] of Object.entries(BACKEND_COMMAND)) {
    if (commandResolves(command(), dirs)) available.push(id);
  }
  return available;
}
