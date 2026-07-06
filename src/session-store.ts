import * as fs from 'fs';
import * as path from 'path';

const STORE_FILE = '.muster-sessions.json';

export function getSessionId(backend: string, cwd = process.cwd()): string | undefined {
  const file = path.join(cwd, STORE_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data[backend];
  } catch {
    return undefined;
  }
}

export function saveSessionId(backend: string, id: string, cwd = process.cwd()) {
  const file = path.join(cwd, STORE_FILE);
  let data: Record<string, string> = {};
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  data[backend] = id;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
