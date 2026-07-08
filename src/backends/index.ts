import { Backend } from '../types';
import { ClaudeBackend } from './claude';
import { GrokBackend } from './grok';
import { KiroBackend } from './kiro';
import { CodexBackend } from './codex';
import { OpenCodeBackend } from './opencode';

export const BACKEND_IDS = ['claude', 'grok', 'kiro', 'codex', 'opencode'] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

export function makeBackend(name: string): Backend {
  switch (name) {
    case 'grok':
      return new GrokBackend();
    case 'kiro':
      return new KiroBackend();
    case 'codex':
      return new CodexBackend();
    case 'opencode':
      return new OpenCodeBackend();
    case 'claude':
      return new ClaudeBackend();
    default:
      throw new Error(`unsupported backend: ${name}`);
  }
}
