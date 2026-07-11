/**
 * Safe discovery of declared repository verification scripts.
 * Never invents arbitrary shell; only reads package.json scripts (and similar).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveredCheck {
  name: string;
  command: string;
  source: 'package.json';
}

const PREFERRED_SCRIPT_NAMES = [
  'test',
  'compile',
  'check:svelte',
  'test:webview',
  'test:task-audit',
  'test:source-boundary',
  'test:evidence',
  'lint',
  'typecheck',
  'build',
] as const;

export function discoverPackageScripts(cwd: string): DiscoveredCheck[] {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [];
  }
  const scripts = (raw as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    return [];
  }
  const map = scripts as Record<string, unknown>;
  const out: DiscoveredCheck[] = [];
  for (const name of PREFERRED_SCRIPT_NAMES) {
    if (typeof map[name] === 'string' && (map[name] as string).length > 0) {
      out.push({
        name,
        command: `npm run ${name}`,
        source: 'package.json',
      });
    }
  }
  // Include other scripts only if explicitly named test*/check*
  for (const [name, cmd] of Object.entries(map)) {
    if (PREFERRED_SCRIPT_NAMES.includes(name as (typeof PREFERRED_SCRIPT_NAMES)[number])) {
      continue;
    }
    if (
      typeof cmd === 'string' &&
      (name.startsWith('test') || name.startsWith('check'))
    ) {
      out.push({ name, command: `npm run ${name}`, source: 'package.json' });
    }
  }
  return out;
}

export function defaultVerificationSelection(checks: DiscoveredCheck[]): DiscoveredCheck[] {
  const preferred = new Set(['test', 'compile', 'check:svelte']);
  const selected = checks.filter((c) => preferred.has(c.name));
  return selected.length > 0 ? selected : checks.slice(0, 3);
}
