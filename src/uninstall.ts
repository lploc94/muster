import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ID = 'tlelabs.muster';
const STORAGE_OVERRIDE_ENV = 'MUSTER_GLOBAL_STORAGE_DIR';
const REGISTRY_OVERRIDE_ENV = 'MUSTER_UNINSTALL_REGISTRY_PATH';
const REGISTRY_FILE = 'uninstall-storage.json';

type UninstallResult =
  | { kind: 'reclaimed'; bytes: number }
  | { kind: 'absent' }
  | { kind: 'refused' };

type StorageRegistry = {
  version: 1;
  targets: Record<string, string>;
};

function registryPath(homeDirectory = os.homedir()): string {
  return process.env[REGISTRY_OVERRIDE_ENV] ?? path.join(homeDirectory, '.muster', REGISTRY_FILE);
}

function installationKey(extensionRoot: string): string {
  return path.resolve(extensionRoot);
}

function isStorageDirectory(directory: string): boolean {
  return path.isAbsolute(directory) && path.basename(path.resolve(directory)) === EXTENSION_ID;
}

function emptyRegistry(): StorageRegistry {
  return { version: 1, targets: {} };
}

async function readRegistry(filePath = registryPath()): Promise<StorageRegistry> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyRegistry();
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !value.targets || typeof value.targets !== 'object' || Array.isArray(value.targets)) {
      return emptyRegistry();
    }
    const targets: Record<string, string> = {};
    for (const [key, target] of Object.entries(value.targets as Record<string, unknown>)) {
      if (typeof target === 'string' && isStorageDirectory(target)) targets[key] = target;
    }
    return { version: 1, targets };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    return emptyRegistry();
  }
}

async function writeRegistry(registry: StorageRegistry, filePath = registryPath()): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, filePath);
  } catch (error: unknown) {
    // Windows may reject replacement while another Extension Host briefly reads
    // or registers the same installation. A registry miss must never prevent
    // activation; leave the prior safe target intact and clean the temp best-effort.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Records the exact profile/authority-resolved global storage path for this installation. */
export async function registerUninstallStorageTarget(
  extensionRoot: string,
  storageDirectory: string,
): Promise<void> {
  if (!isStorageDirectory(storageDirectory)) return;
  const registry = await readRegistry();
  registry.targets[installationKey(extensionRoot)] = path.resolve(storageDirectory);
  await writeRegistry(registry);
}

function currentInstallationRoot(): string {
  // Compiled hook runs from <extension root>/dist/src/uninstall.js.
  return path.resolve(__dirname, '..', '..');
}

async function resolveStorageDirectory(): Promise<string | undefined> {
  const override = process.env[STORAGE_OVERRIDE_ENV];
  if (override !== undefined) return isStorageDirectory(override) ? override : undefined;
  const registry = await readRegistry();
  return registry.targets[installationKey(currentInstallationRoot())];
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        bytes += await directoryBytes(entryPath);
      } else {
        bytes += (await lstat(entryPath)).size;
      }
    } catch (error: unknown) {
      // A child can disappear while uninstall walks storage. That is harmless:
      // keep calculating what remains and still remove the parent directory.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return bytes;
}

async function reclaimStorageDirectory(directory: string | undefined): Promise<UninstallResult> {
  if (!directory || !isStorageDirectory(directory)) return { kind: 'refused' };

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
  const result = await reclaimStorageDirectory(await resolveStorageDirectory());
  if (result.kind === 'reclaimed') {
    process.stdout.write(`uninstall: reclaimed_bytes: ${result.bytes}\n`);
  } else {
    process.stdout.write(`uninstall: ${result.kind}\n`);
  }
}

if (require.main === module) {
  void main().catch(() => {
    process.stdout.write('uninstall: refused\n');
  });
}
