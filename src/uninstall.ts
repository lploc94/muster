import { lstat, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ID = 'tlelabs.muster';
const STORAGE_OVERRIDE_ENV = 'MUSTER_GLOBAL_STORAGE_DIR';

type UninstallResult =
  | { kind: 'reclaimed'; bytes: number }
  | { kind: 'absent' }
  | { kind: 'refused' };

function defaultGlobalStorageDirectory(platform = process.platform, homeDirectory = os.homedir()): string {
  if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homeDirectory, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', EXTENSION_ID);
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', EXTENSION_ID);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homeDirectory, '.config'), 'Code', 'User', 'globalStorage', EXTENSION_ID);
}

function resolveStorageDirectory(): string {
  return process.env[STORAGE_OVERRIDE_ENV] ?? defaultGlobalStorageDirectory();
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directoryBytes(entryPath);
    } else {
      bytes += (await lstat(entryPath)).size;
    }
  }
  return bytes;
}

async function reclaimStorageDirectory(directory: string): Promise<UninstallResult> {
  if (path.basename(path.resolve(directory)) !== EXTENSION_ID) return { kind: 'refused' };

  try {
    const bytes = await directoryBytes(directory);
    await rm(directory, { recursive: true, force: false });
    return { kind: 'reclaimed', bytes };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'refused' };
  }
}

async function main(): Promise<void> {
  const result = await reclaimStorageDirectory(resolveStorageDirectory());
  if (result.kind === 'reclaimed') {
    process.stdout.write(`uninstall: reclaimed_bytes: ${result.bytes}\n`);
  } else {
    process.stdout.write(`uninstall: ${result.kind}\n`);
  }
}

void main().catch(() => {
  process.stdout.write('uninstall: refused\n');
});
