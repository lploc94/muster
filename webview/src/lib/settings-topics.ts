/**
 * Presentation-only Settings topic taxonomy and keyboard policy.
 *
 * Local webview model for the five-topic Settings tab shell. Not part of the
 * host-webview protocol and not a generic settings registry — active topics
 * keep their own explicit host helpers and save contracts.
 *
 * Independent of Svelte DOM code.
 */

/** Stable product topic identifiers for Settings navigation. */
export type SettingsTopicId =
  | 'task-types'
  | 'permissions'
  | 'retention'
  | 'models-and-clis'
  | 'context-and-mcp';

/** Whether a topic has an active configuration surface or is a placeholder. */
export type SettingsTopicAvailability = 'active' | 'coming-soon';

/** Presentation metadata for one Settings topic. */
export interface SettingsTopic {
  id: SettingsTopicId;
  label: string;
  availability: SettingsTopicAvailability;
  /**
   * Coming-soon scope copy. Present only when `availability === 'coming-soon'`.
   * Active topics render their own forms and do not use this field.
   */
  description?: string;
}

/** Ordered, fixed product taxonomy — presentation only. */
export const SETTINGS_TOPICS: readonly SettingsTopic[] = [
  {
    id: 'task-types',
    label: 'Task Types',
    availability: 'active',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    availability: 'active',
  },
  {
    id: 'retention',
    label: 'Retention',
    availability: 'active',
  },
  {
    id: 'models-and-clis',
    label: 'Models and CLIs',
    availability: 'coming-soon',
    description:
      'Future configuration for backend CLI discovery, preferred models, and related catalog options. Backend and model enumeration already exist for task selection; a dedicated persisted Models and CLIs settings domain is not available yet.',
  },
  {
    id: 'context-and-mcp',
    label: 'Context and MCP',
    availability: 'coming-soon',
    description:
      'Future configuration for context-engine endpoints and MCP-related settings. MCP injection is implemented today, while a configurable context-engine URL or port remains planned.',
  },
] as const;

const TOPIC_BY_ID: ReadonlyMap<SettingsTopicId, SettingsTopic> = new Map(
  SETTINGS_TOPICS.map((topic) => [topic.id, topic]),
);

const TOPIC_IDS: readonly SettingsTopicId[] = SETTINGS_TOPICS.map((topic) => topic.id);

/** Type guard: true only for the five known Settings topic ids. */
export function isSettingsTopicId(value: unknown): value is SettingsTopicId {
  return typeof value === 'string' && TOPIC_BY_ID.has(value as SettingsTopicId);
}

/** Look up topic metadata; returns undefined for unknown ids (fail closed). */
export function getSettingsTopic(id: SettingsTopicId): SettingsTopic | undefined {
  return TOPIC_BY_ID.get(id);
}

/** Stable DOM id for the tab control that activates a topic. */
export function settingsTabId(id: SettingsTopicId): string | undefined {
  if (!isSettingsTopicId(id)) return undefined;
  return `settings-tab-${id}`;
}

/** Stable DOM id for the tabpanel that presents a topic. */
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
  /** Currently active (selected) topic id. */
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
 * - Unknown active topic: none
 * - ArrowRight / ArrowLeft: activate neighbor with wraparound
 * - Home / End: activate first / last topic
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
