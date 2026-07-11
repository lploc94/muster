/**
 * Client-side slash command suggestions (host always re-parses/validates).
 */

export interface CommandSuggestion {
  id: string;
  label: string;
  summary: string;
  aliases?: string[];
}

export const COMMAND_SUGGESTIONS: CommandSuggestion[] = [
  { id: 'help', label: '/help', summary: 'List native commands' },
  { id: 'new', label: '/new', summary: 'Draft chat or /new <goal> to plan' },
  { id: 'tasks', label: '/tasks', summary: 'List tasks', aliases: ['list'] },
  { id: 'status', label: '/status', summary: 'Focused task status' },
  { id: 'approve', label: '/approve', summary: 'Approve pending plan' },
  { id: 'replan', label: '/replan', summary: 'Revise plan' },
  { id: 'implement', label: '/implement', summary: 'Run implementation' },
  { id: 'test', label: '/test', summary: 'Collect test evidence' },
  { id: 'review', label: '/review', summary: 'Independent review' },
  { id: 'debug', label: '/debug', summary: 'Debug failure' },
  { id: 'verify', label: '/verify', summary: 'Verification evidence' },
  { id: 'finish', label: '/finish', summary: 'Stage outcome proposal' },
  { id: 'context', label: '/context', summary: 'Context/usage report' },
  { id: 'compact', label: '/compact', summary: 'Compact transcript' },
  { id: 'export', label: '/export', summary: 'Export markdown/json' },
  { id: 'archive', label: '/archive', summary: 'Archive workflow' },
  { id: 'cancel', label: '/cancel', summary: 'Cancel focused task' },
  { id: 'focus', label: '/focus', summary: 'Focus task by id' },
];

/** True when composer text is a slash command (leading /). */
export function looksLikeSlashCommand(text: string): boolean {
  return /^\s*\/\S/.test(text);
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
