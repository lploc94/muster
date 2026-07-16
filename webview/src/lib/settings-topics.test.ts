import { describe, expect, it } from 'vitest';
import {
  SETTINGS_TOPICS,
  getSettingsTopic,
  isSettingsTopicId,
  resolveSettingsTabKeyIntent,
  settingsPanelId,
  settingsTabId,
  type SettingsTabKeyboardInput,
  type SettingsTopicId,
} from './settings-topics';

function key(
  partial: Partial<SettingsTabKeyboardInput> & Pick<SettingsTabKeyboardInput, 'key'>,
): SettingsTabKeyboardInput {
  return {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...partial,
  };
}

describe('SETTINGS_TOPICS taxonomy', () => {
  it('renders exactly the three actionable domains in product order', () => {
    expect(SETTINGS_TOPICS.map((topic) => topic.id)).toEqual([
      'agents',
      'execution',
      'data',
    ]);
    expect(SETTINGS_TOPICS.map((topic) => topic.label)).toEqual([
      'Agents',
      'Execution',
      'Data',
    ]);
    expect(SETTINGS_TOPICS).toHaveLength(3);
  });

  it('uses unique ids and labels', () => {
    const ids = SETTINGS_TOPICS.map((topic) => topic.id);
    const labels = SETTINGS_TOPICS.map((topic) => topic.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('does not treat Connections as a rendered domain (reserved, not actionable)', () => {
    expect(SETTINGS_TOPICS.some((topic) => (topic.id as string) === 'connections')).toBe(false);
    expect(isSettingsTopicId('connections')).toBe(false);
    expect(getSettingsTopic('connections' as SettingsTopicId)).toBeUndefined();
  });

  it('rejects legacy five-topic ids and unknown ids fail-closed', () => {
    for (const legacy of [
      'task-types',
      'permissions',
      'retention',
      'models-and-clis',
      'context-and-mcp',
    ]) {
      expect(isSettingsTopicId(legacy)).toBe(false);
      expect(getSettingsTopic(legacy as SettingsTopicId)).toBeUndefined();
    }
    expect(isSettingsTopicId('appearance')).toBe(false);
    expect(isSettingsTopicId('agents')).toBe(true);
    expect(getSettingsTopic('telemetry' as SettingsTopicId)).toBeUndefined();
    expect(getSettingsTopic('agents')?.label).toBe('Agents');
  });
});

describe('stable tab and panel ids', () => {
  it('derives stable, unique ARIA-friendly ids for every domain', () => {
    const tabIds = SETTINGS_TOPICS.map((topic) => settingsTabId(topic.id));
    const panelIds = SETTINGS_TOPICS.map((topic) => settingsPanelId(topic.id));

    expect(tabIds).toEqual([
      'settings-tab-agents',
      'settings-tab-execution',
      'settings-tab-data',
    ]);
    expect(panelIds).toEqual([
      'settings-panel-agents',
      'settings-panel-execution',
      'settings-panel-data',
    ]);
    expect(new Set(tabIds).size).toBe(3);
    expect(new Set(panelIds).size).toBe(3);
    for (let i = 0; i < tabIds.length; i += 1) {
      expect(tabIds[i]).not.toBe(panelIds[i]);
    }
  });

  it('returns undefined for unknown domain ids instead of inventing ids', () => {
    expect(settingsTabId('appearance' as SettingsTopicId)).toBeUndefined();
    expect(settingsPanelId('connections' as SettingsTopicId)).toBeUndefined();
  });
});

describe('resolveSettingsTabKeyIntent', () => {
  it('moves with ArrowRight and wraps from last to first', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight' }), { activeTopicId: 'agents' }),
    ).toEqual({ kind: 'activate', topicId: 'execution' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight' }), { activeTopicId: 'data' }),
    ).toEqual({ kind: 'activate', topicId: 'agents' });
  });

  it('moves with ArrowLeft and wraps from first to last', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowLeft' }), { activeTopicId: 'execution' }),
    ).toEqual({ kind: 'activate', topicId: 'agents' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowLeft' }), { activeTopicId: 'agents' }),
    ).toEqual({ kind: 'activate', topicId: 'data' });
  });

  it('jumps to first and last with Home and End', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'Home' }), { activeTopicId: 'execution' }),
    ).toEqual({ kind: 'activate', topicId: 'agents' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'End' }), { activeTopicId: 'execution' }),
    ).toEqual({ kind: 'activate', topicId: 'data' });
  });

  it('ignores IME composition and keyCode 229', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight', isComposing: true }), {
        activeTopicId: 'agents',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'Home', keyCode: 229 }), {
        activeTopicId: 'data',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('fails closed for modified shortcuts and unknown/ignored keys', () => {
    for (const partial of [
      { key: 'ArrowRight', ctrlKey: true },
      { key: 'ArrowLeft', metaKey: true },
      { key: 'Home', altKey: true },
      { key: 'End', shiftKey: true },
      { key: 'ArrowDown' },
      { key: 'Tab' },
      { key: 'Enter' },
      { key: 'a' },
    ] as const) {
      expect(
        resolveSettingsTabKeyIntent(key(partial), { activeTopicId: 'agents' }),
      ).toEqual({ kind: 'none' });
    }
  });

  it('fails closed for unknown active domains', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight' }), {
        activeTopicId: 'appearance' as SettingsTopicId,
      }),
    ).toEqual({ kind: 'none' });
  });
});
