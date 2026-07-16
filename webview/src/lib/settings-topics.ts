/**
 * Presentation-only Settings domain taxonomy and keyboard policy.
 *
 * Local webview model for the Settings tab shell. The product taxonomy defines
 * four domains (Agents, Execution, Connections, Data); only domains with an
 * actionable host-backed configuration surface are rendered as tabs. Today that
 * means three tabs: Agents, Execution, Data. Connections is a reserved domain
 * with no host-owned control yet, so it is intentionally not a rendered topic.
 *
 * Not part of the host-webview protocol and not a generic settings registry —
 * active domains keep their own explicit host helpers and save contracts.
 *
 * Independent of Svelte DOM code.
 */

/** Stable product domain identifiers rendered in Settings navigation. */
export type SettingsTopicId = 'agents' | 'execution' | 'data';

/** Presentation metadata for one rendered Settings domain. */
export interface SettingsTopic {
  id: SettingsTopicId;
  label: string;
}

/** Ordered, fixed product taxonomy — only actionable domains are rendered. */
export const SETTINGS_TOPICS: readonly SettingsTopic[] = [
  {
    id: 'agents',
    label: 'Agents',
  },
  {
    id: 'execution',
    label: 'Execution',
  },
  {
    id: 'data',
    label: 'Data',
  },
] as const;

const TOPIC_BY_ID: ReadonlyMap<SettingsTopicId, SettingsTopic> = new Map(
  SETTINGS_TOPICS.map((topic) => [topic.id, topic]),
);

const TOPIC_IDS: readonly SettingsTopicId[] = SETTINGS_TOPICS.map((topic) => topic.id);

/** Type guard: true only for the rendered Settings domain ids. */
export function isSettingsTopicId(value: unknown): value is SettingsTopicId {
  return typeof value === 'string' && TOPIC_BY_ID.has(value as SettingsTopicId);
}

/** Look up domain metadata; returns undefined for unknown ids (fail closed). */
export function getSettingsTopic(id: SettingsTopicId): SettingsTopic | undefined {
  return TOPIC_BY_ID.get(id);
}

/** Stable DOM id for the tab control that activates a domain. */
export function settingsTabId(id: SettingsTopicId): string | undefined {
  if (!isSettingsTopicId(id)) return undefined;
  return `settings-tab-${id}`;
}

/** Stable DOM id for the tabpanel that presents a domain. */
export function settingsPanelId(id: SettingsTopicId): string | undefined {
  if (!isSettingsTopicId(id)) return undefined;
  return `settings-panel-${id}`;
}

/** Keyboard event shape used by the Settings tablist policy. */
export interface SettingsTabKeyboardInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  isComposing: boolean;
  /** Legacy IME composition signal (keyCode 229). */
  keyCode?: number;
}

/** Tablist state needed to resolve a key intent. */
export interface SettingsTabKeyboardOptions {
  /** Currently active (selected) domain id. */
  activeTopicId: SettingsTopicId;
}

/** Resolved keyboard intent for the Settings tablist. */
export type SettingsTabKeyIntent =
  | { kind: 'none' }
  | { kind: 'activate'; topicId: SettingsTopicId };

function isIme(event: SettingsTabKeyboardInput): boolean {
  return event.isComposing || event.keyCode === 229;
}

function hasModifier(event: SettingsTabKeyboardInput): boolean {
  return Boolean(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey);
}

function indexOfTopic(id: SettingsTopicId): number {
  return TOPIC_IDS.indexOf(id);
}

/**
 * Pure keyboard → tab activation mapping (WAI-ARIA tabs, automatic activation).
 *
 * - IME composition / keyCode 229: none
 * - Modified shortcuts (Shift/Ctrl/Meta/Alt): none
 * - Unknown active domain: none
 * - ArrowRight / ArrowLeft: activate neighbor with wraparound
 * - Home / End: activate first / last domain
 * - All other keys: none (Tab/Enter/Space stay with the browser or host)
 */
export function resolveSettingsTabKeyIntent(
  event: SettingsTabKeyboardInput,
  opts: SettingsTabKeyboardOptions,
): SettingsTabKeyIntent {
  if (isIme(event)) return { kind: 'none' };
  if (hasModifier(event)) return { kind: 'none' };

  const currentIndex = indexOfTopic(opts.activeTopicId);
  if (currentIndex < 0) return { kind: 'none' };

  const count = TOPIC_IDS.length;
  const { key } = event;

  if (key === 'ArrowRight') {
    const next = (currentIndex + 1) % count;
    return { kind: 'activate', topicId: TOPIC_IDS[next]! };
  }

  if (key === 'ArrowLeft') {
    const next = (currentIndex - 1 + count) % count;
    return { kind: 'activate', topicId: TOPIC_IDS[next]! };
  }

  if (key === 'Home') {
    return { kind: 'activate', topicId: TOPIC_IDS[0]! };
  }

  if (key === 'End') {
    return { kind: 'activate', topicId: TOPIC_IDS[count - 1]! };
  }

  return { kind: 'none' };
}
