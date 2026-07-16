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
  it('exposes exactly five topics in the fixed product order', () => {
    expect(SETTINGS_TOPICS.map((topic) => topic.id)).toEqual([
      'task-types',
      'permissions',
      'retention',
      'models-and-clis',
      'context-and-mcp',
    ]);
    expect(SETTINGS_TOPICS.map((topic) => topic.label)).toEqual([
      'Task Types',
      'Permissions',
      'Runtime & Storage',
      'Models and CLIs',
      'Context and MCP',
    ]);
    expect(SETTINGS_TOPICS).toHaveLength(5);
  });

  it('uses unique ids and labels', () => {
    const ids = SETTINGS_TOPICS.map((topic) => topic.id);
    const labels = SETTINGS_TOPICS.map((topic) => topic.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('marks the first three topics active and the last two coming soon', () => {
    expect(
      SETTINGS_TOPICS.filter((topic) => topic.availability === 'active').map((topic) => topic.id),
    ).toEqual(['task-types', 'permissions', 'retention']);
    expect(
      SETTINGS_TOPICS.filter((topic) => topic.availability === 'coming-soon').map(
        (topic) => topic.id,
      ),
    ).toEqual(['models-and-clis', 'context-and-mcp']);
  });

  it('provides descriptive placeholder copy only for coming-soon topics', () => {
    for (const topic of SETTINGS_TOPICS) {
      if (topic.availability === 'coming-soon') {
        const description = topic.description;
        expect(description).toBeTruthy();
        expect(description!.length).toBeGreaterThan(20);
        expect(description!.toLowerCase()).not.toContain('disabled');
      } else {
        expect(topic.description).toBeUndefined();
      }
    }

    const models = getSettingsTopic('models-and-clis');
    const context = getSettingsTopic('context-and-mcp');
    expect(models?.description).toMatch(/model|cli|backend/i);
    expect(context?.description).toMatch(/context|mcp/i);
  });

  it('rejects unknown topic ids fail-closed', () => {
    expect(isSettingsTopicId('appearance')).toBe(false);
    expect(isSettingsTopicId('task-types')).toBe(true);
    expect(getSettingsTopic('telemetry' as SettingsTopicId)).toBeUndefined();
    expect(getSettingsTopic('task-types')?.label).toBe('Task Types');
  });
});

describe('stable tab and panel ids', () => {
  it('derives stable, unique ARIA-friendly ids for every topic', () => {
    const tabIds = SETTINGS_TOPICS.map((topic) => settingsTabId(topic.id));
    const panelIds = SETTINGS_TOPICS.map((topic) => settingsPanelId(topic.id));

    expect(tabIds).toEqual([
      'settings-tab-task-types',
      'settings-tab-permissions',
      'settings-tab-retention',
      'settings-tab-models-and-clis',
      'settings-tab-context-and-mcp',
    ]);
    expect(panelIds).toEqual([
      'settings-panel-task-types',
      'settings-panel-permissions',
      'settings-panel-retention',
      'settings-panel-models-and-clis',
      'settings-panel-context-and-mcp',
    ]);
    expect(new Set(tabIds).size).toBe(5);
    expect(new Set(panelIds).size).toBe(5);
    for (let i = 0; i < tabIds.length; i += 1) {
      expect(tabIds[i]).not.toBe(panelIds[i]);
    }
  });

  it('returns undefined for unknown topic ids instead of inventing ids', () => {
    expect(settingsTabId('appearance' as SettingsTopicId)).toBeUndefined();
    expect(settingsPanelId('telemetry' as SettingsTopicId)).toBeUndefined();
  });
});

describe('resolveSettingsTabKeyIntent', () => {
  it('moves with ArrowRight and wraps from last to first', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight' }), { activeTopicId: 'task-types' }),
    ).toEqual({ kind: 'activate', topicId: 'permissions' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight' }), {
        activeTopicId: 'context-and-mcp',
      }),
    ).toEqual({ kind: 'activate', topicId: 'task-types' });
  });

  it('moves with ArrowLeft and wraps from first to last', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowLeft' }), { activeTopicId: 'permissions' }),
    ).toEqual({ kind: 'activate', topicId: 'task-types' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowLeft' }), { activeTopicId: 'task-types' }),
    ).toEqual({ kind: 'activate', topicId: 'context-and-mcp' });
  });

  it('jumps to first and last with Home and End', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'Home' }), { activeTopicId: 'retention' }),
    ).toEqual({ kind: 'activate', topicId: 'task-types' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'End' }), { activeTopicId: 'permissions' }),
    ).toEqual({ kind: 'activate', topicId: 'context-and-mcp' });
  });

  it('ignores IME composition and keyCode 229', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight', isComposing: true }), {
        activeTopicId: 'task-types',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'Home', keyCode: 229 }), {
        activeTopicId: 'retention',
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
        resolveSettingsTabKeyIntent(key(partial), { activeTopicId: 'task-types' }),
      ).toEqual({ kind: 'none' });
    }
  });

  it('fails closed for unknown active topics', () => {
    expect(
      resolveSettingsTabKeyIntent(key({ key: 'ArrowRight' }), {
        activeTopicId: 'appearance' as SettingsTopicId,
      }),
    ).toEqual({ kind: 'none' });
  });
});
