/** Client-side discovery; host always parses and validates execution. */

import { COMMAND_BEHAVIOR } from '../../../src/commands/behavior-matrix';

export interface CommandSuggestion {
  id: string;
  label: string;
  summary: string;
  aliases?: string[];
  availability: 'implemented' | 'disabled';
  effectClass: string;
  requiresTask: boolean;
  requiresArgs: boolean;
  instantSafe: boolean;
  presenter: string;
  disabledReason?: string;
}

export const COMMAND_SUGGESTIONS: CommandSuggestion[] = COMMAND_BEHAVIOR.map((command) => ({
  id: command.id,
  label: `/${command.id}`,
  summary: command.summary,
  aliases: [...command.aliases],
  availability: command.availability,
  effectClass: command.effectClass,
  requiresTask: command.requiresTask,
  requiresArgs: command.requiresArgs,
  instantSafe: command.instantSafe,
  presenter: command.presenter,
  disabledReason: command.disabledReason,
}));

/** True when composer text is a slash command (leading /). */
export function looksLikeSlashCommand(text: string): boolean {
  // `/` itself is the discovery gesture: show every command before the user
  // has typed a name. Keep the host parser stricter — it will reject a bare
  // slash only if the user attempts to submit it.
  return /^\s*\/\S*/.test(text);
}

/** Filter suggestions for autocomplete from partial input after `/`. */
export function filterCommandSuggestions(partial: string): CommandSuggestion[] {
  const q = partial.replace(/^\//, '').toLowerCase();
  if (!q) return COMMAND_SUGGESTIONS;
  return COMMAND_SUGGESTIONS.filter(
    (c) =>
      c.id.startsWith(q) ||
      c.label.slice(1).startsWith(q) ||
      c.aliases?.some((a) => a.startsWith(q)),
  );
}
