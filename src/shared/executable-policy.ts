import { basename } from 'node:path';

export const BARE_EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const SCRIPT_EXECUTABLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'node',
  'python',
  'python3',
]);

export function normalizeExecutableName(executable: string): string {
  return basename(executable).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

export function validateAllowlistedExecutable(
  executable: string,
  allowlist: ReadonlySet<string>,
): { ok: true; executable: string } | { ok: false; reason: string } {
  if (!BARE_EXECUTABLE_NAME.test(executable)) {
    return {
      ok: false,
      reason: `executable must be a bare name (no path component): ${executable}`,
    };
  }
  const normalized = normalizeExecutableName(executable);
  if (!allowlist.has(normalized)) {
    return { ok: false, reason: `executable not allowlisted: ${normalized}` };
  }
  return { ok: true, executable };
}
