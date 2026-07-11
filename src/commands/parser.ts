/**
 * Deterministic slash-command parser.
 * Plain text (no leading `/`) stays a normal prompt.
 */

import type { CommandParseResult } from './types';

/**
 * Split args with simple shell-like quoting ("..." or '...') and backslash escapes.
 */
export function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Parse composer / CLI input.
 * - empty / whitespace → empty
 * - `/cmd args` → command
 * - otherwise → plain prompt
 */
export function parseInput(input: string): CommandParseResult {
  const text = input.replace(/^\uFEFF/, '');
  if (text.trim().length === 0) {
    return { kind: 'empty' };
  }

  // Slash command only when `/` is the first non-whitespace character
  const leading = text.match(/^(\s*)\/(\S+)([\s\S]*)$/);
  if (!leading) {
    return { kind: 'plain', text };
  }

  const name = leading[2];
  // Strip one leading whitespace run from args for rawArgs cleanliness
  const rawArgs = leading[3].replace(/^\s+/, '').replace(/\s+$/, '');
  const argv = rawArgs.length > 0 ? splitArgs(rawArgs) : [];

  // Unknown names still parse as commands — registry resolves later
  return { kind: 'command', name, rawArgs, argv };
}

/** True when input should be routed to the command service (not TaskEngine.send). */
export function isSlashCommand(input: string): boolean {
  return parseInput(input).kind === 'command';
}
