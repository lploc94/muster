<script lang="ts">
  import { onMount } from 'svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import TaskHistoryList from './components/TaskList.svelte';
  import TaskWorkspace from './components/TaskWorkspace.svelte';
  import PermissionCard from './components/PermissionCard.svelte';
  import { tasks } from './lib/tasks.svelte';
  import { threadStore } from './lib/thread.svelte';
  import {
    effectiveRuntimeActivity,
    isExtMessage,
    isProtocolCompatible,
    post,
  } from './lib/protocol';
  import type {
    PendingAsk,
    PendingPermission,
    RetentionSettingId,
    RetentionSettingSnapshot,
    SettingsUpdateResult,
  } from './lib/protocol';
  import { tip } from './lib/tooltip';

  const SETTING_LABELS: Record<RetentionSettingId, string> = {
    maxTurnsPerTask: 'Maximum turns per task',
    maxStoredOutputChars: 'Maximum stored output characters',
  };

  let pendingAsk = $state<PendingAsk | null>(null);
  let pendingPermission = $state<PendingPermission | null>(null);
  let activeTurnId = $state<string | null>(null);
  const visibleCommandError = $derived(
    tasks.commandError && (!tasks.commandError.taskId || tasks.commandError.taskId === tasks.focusedTaskId)
      ? tasks.commandError
      : null,
  );
  // Set when a bootstrap `snapshot` arrives stamped with a protocolVersion that
  // differs from ours (host<->webview drift). Surfaces a visible banner instead
  // of silently dropping the drifted message.
  let protocolMismatch = $state(false);

  // When no focused task and not in draft, we show the previous tasks list as entry
  const inChat = $derived(tasks.draftMode || !!tasks.focusedTaskId);
  let historyOpen = $state(false);
  let settingsOpen = $state(false);
  let settingsSnapshot = $state<RetentionSettingSnapshot | null>(null);
  let settingsLoading = $state(false);
  let settingsSavingSettingId = $state<RetentionSettingId | null>(null);
  let settingsSavedMessage = $state<string | null>(null);
  let settingsGlobalError = $state<string | null>(null);
  let settingsFieldErrors = $state<Partial<Record<RetentionSettingId, string>>>({});

  function selectTask(taskId: string) {
    tasks.focusTask(taskId);
    post({ type: 'focusTask', taskId });
    post({ type: 'hydrateSubtree', taskId });
    historyOpen = false;
  }

  function clearHistory() {
    historyOpen = false;
    post({ type: 'clearHistory' });
  }

  function deleteTask(taskId: string) {
    post({ type: 'deleteTask', taskId });
  }

  function renameTask(taskId: string, goal: string) {
    post({ type: 'renameTask', taskId, goal });
  }

  function openSettings() {
    historyOpen = false;
    settingsOpen = true;
    settingsLoading = !settingsSnapshot;
    settingsGlobalError = null;
    settingsSavedMessage = null;
    settingsFieldErrors = {};
    post({ type: 'requestSettings' });
  }

  function closeSettings() {
    settingsOpen = false;
  }

  function backToList() {
    tasks.focusedTaskId = null;
    tasks.draftMode = false;
    threadStore.clearFocus();
    historyOpen = false;
    // Tell the host we left the chat so it drops its focus; otherwise a later
    // snapshot (e.g. after Clear history) would re-open the stale chat.
    post({ type: 'blurTask' });
  }

  function settingLabel(settingId: RetentionSettingId): string {
    return SETTING_LABELS[settingId];
  }

  function updateSnapshotValue(settingId: RetentionSettingId, value: number) {
    if (!settingsSnapshot) return;
    settingsSnapshot = {
      settings: settingsSnapshot.settings.map((setting) =>
        setting.id === settingId ? { ...setting, value } : setting,
      ),
    };
  }

  function applySettingsUpdateResult(result: SettingsUpdateResult) {
    settingsLoading = false;
    settingsSavingSettingId = null;
    settingsSavedMessage = null;

    if (result.ok) {
      updateSnapshotValue(result.settingId, result.value);
      settingsFieldErrors = { ...settingsFieldErrors, [result.settingId]: undefined };
      settingsGlobalError = null;
      settingsSavedMessage = `Saved ${settingLabel(result.settingId)}.`;
      return;
    }

    if ('settingId' in result) {
      if (result.code === 'updateFailed') {
        settingsGlobalError = `Unable to save ${settingLabel(result.settingId)}. Check the VS Code setting and try again.`;
      } else {
        settingsFieldErrors = { ...settingsFieldErrors, [result.settingId]: result.message };
      }
      return;
    }

    settingsGlobalError = 'Unable to load or save settings. Check the VS Code setting and try again.';
  }

  function saveSetting(settingId: RetentionSettingId, value: number) {
    settingsSavingSettingId = settingId;
    settingsSavedMessage = null;
    settingsGlobalError = null;
    settingsFieldErrors = { ...settingsFieldErrors, [settingId]: undefined };
    post({ type: 'updateSetting', settingId, value });
  }

  onMount(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data;

      // Protocol-drift detection: the bootstrap `snapshot` carries the host's
      // protocolVersion. Check it BEFORE the strict isExtMessage guard, because a
      // drifted snapshot (shapes changed on the other side) may not pass that
      // guard and would otherwise be silently dropped. A mismatch — or an absent
      // version from an old host — raises a visible banner instead of proceeding.
      if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'snapshot') {
        if (!isProtocolCompatible((msg as { protocolVersion?: unknown }).protocolVersion)) {
          protocolMismatch = true;
          return;
        }
        protocolMismatch = false;
      }

      if (!isExtMessage(msg)) return;

      switch (msg.type) {
        case 'snapshot': {
          tasks.applySnapshot(msg);
          pendingAsk = msg.pendingAsk ?? null;
          activeTurnId = msg.activeTurnId ?? null;

          if (msg.focusedTaskId) {
            const focused = tasks.tasks.get(msg.focusedTaskId);
            threadStore.focusTask(
              msg.focusedTaskId,
              msg.transcript,
              msg.activeTurnId,
              focused?.viewStatus,
              {
                lifecycle: focused?.lifecycle,
                runtimeActivity: focused ? effectiveRuntimeActivity(focused) : null,
              },
            );
          } else if (tasks.draftMode) {
            threadStore.clearFocus();
          }
          break;
        }

        case 'taskUpdated': {
          tasks.applyTaskUpdated(msg.taskId, msg.storeRevision, msg.patch);
          if (msg.taskId === tasks.focusedTaskId) {
            const focused = tasks.tasks.get(msg.taskId);
            if (focused) {
              threadStore.updateReadOnly(focused.lifecycle);
              threadStore.updateRuntimeFlags(effectiveRuntimeActivity(focused));
            } else if (msg.patch.lifecycle) {
              threadStore.updateReadOnly(msg.patch.lifecycle);
            }
          }
          break;
        }

        case 'settingsSnapshot':
          settingsSnapshot = msg.snapshot;
          settingsLoading = false;
          settingsGlobalError = null;
          break;

        case 'settingsUpdateResult':
          applySettingsUpdateResult(msg.result);
          break;

        case 'turnStart':
          threadStore.onTurnStart(msg.taskId, msg.turnId);
          if (msg.taskId === tasks.focusedTaskId) {
            activeTurnId = msg.turnId;
          }
          break;

        case 'event':
          threadStore.onEvent(msg.taskId, msg.turnId, msg.event);
          break;

        case 'turnDone':
          threadStore.onTurnDone(msg.taskId, msg.turnId);
          if (msg.taskId === tasks.focusedTaskId && msg.turnId === activeTurnId) {
            activeTurnId = null;
          }
          break;

        case 'turnError':
          threadStore.onTurnError(msg.taskId, msg.turnId, msg.message);
          if (msg.taskId === tasks.focusedTaskId && msg.turnId === activeTurnId) {
            activeTurnId = null;
          }
          break;

        case 'transcriptAppend':
          threadStore.onTranscriptAppend(msg.taskId, msg.item);
          break;

        case 'askPending': {
          if (tasks.tasks.has(msg.taskId) && msg.taskId !== tasks.focusedTaskId) {
            tasks.focusTask(msg.taskId);
          }
          if (msg.taskId === tasks.focusedTaskId) {
            pendingAsk = {
              turnId: msg.turnId,
              askId: msg.askId,
              questions: msg.questions,
            };
            activeTurnId = msg.turnId;
          }
          break;
        }

        case 'askCleared':
          if (
            pendingAsk &&
            pendingAsk.askId === msg.askId &&
            pendingAsk.turnId === msg.turnId &&
            msg.taskId === tasks.focusedTaskId
          ) {
            pendingAsk = null;
          }
          break;

        case 'permissionPending':
          // Security gate: show regardless of the focused task — a permission
          // request is session-scoped, and hiding it could silently stall or
          // (worse) misrepresent what the agent is asking to do.
          pendingPermission = {
            sessionId: msg.sessionId,
            permissionId: msg.permissionId,
            title: msg.title,
            kind: msg.kind,
            classification: msg.classification,
            options: msg.options,
          };
          break;

        case 'permissionCleared':
          if (pendingPermission && pendingPermission.permissionId === msg.permissionId) {
            pendingPermission = null;
          }
          break;

        case 'commandError':
          if (!msg.taskId || msg.taskId === tasks.focusedTaskId) {
            tasks.setCommandError(msg.message, msg.taskId ?? null);
          }
          break;

        case 'backendsAvailable':
          tasks.setAvailableBackends(msg.backends);
          break;

        case 'modelsAvailable':
          tasks.setAvailableModels(msg.models);
          break;
      }
    }

    window.addEventListener('message', onMessage);
    // Ask the host which backends are installed so the picker only offers them.
    post({ type: 'listBackends' });
    // Prefetch model lists for the New-task picker (host also prefetches on resolve).
    post({ type: 'listModels' });
    return () => window.removeEventListener('message', onMessage);
  });
</script>

{#if protocolMismatch}
  <div
    class="px-3 py-1 text-xs"
    style="color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));"
  >
    Muster: UI/host version mismatch — reload the window (Developer: Reload Window) to update the panel.
  </div>
{/if}

{#if settingsOpen}
  <SettingsPanel
    onClose={closeSettings}
    snapshot={settingsSnapshot}
    loading={settingsLoading}
    savingSettingId={settingsSavingSettingId}
    savedMessage={settingsSavedMessage}
    globalError={settingsGlobalError}
    fieldErrors={settingsFieldErrors}
    onSave={saveSetting}
  />
{/if}

{#if visibleCommandError}
  <div class="task-command-error" role="alert">
    <div class="min-w-0">
      <div class="font-semibold">Task command failed</div>
      <div class="task-command-error__detail">{visibleCommandError.message}</div>
    </div>
    <button
      type="button"
      class="task-command-error__dismiss"
      onclick={() => tasks.setCommandError(null)}
    >Dismiss</button>
  </div>
{/if}

{#if pendingPermission}
  <PermissionCard
    permissionId={pendingPermission.permissionId}
    title={pendingPermission.title}
    kind={pendingPermission.kind}
    classification={pendingPermission.classification}
    options={pendingPermission.options}
  />
{/if}

{#if !inChat}
  <!-- Entry: New task action, then the searchable previous-tasks list -->
  <div class="flex-1 min-h-0 flex flex-col">
    <div class="shrink-0 flex items-center">
      <button
        type="button"
        class="flex-1 flex items-center gap-2 px-3 py-2 text-sm font-medium text-left hover:bg-[var(--vscode-list-hoverBackground)]"
        onclick={() => { tasks.openNewTaskDraft(); post({ type: 'newTask' }); historyOpen = false; }}
      >
        <span class="codicon codicon-add" style="font-size: 16px;"></span>
        <span>New task</span>
      </button>
      <button
        type="button"
        class="icon-btn shrink-0 mr-2"
        style="width: 22px; height: 22px;"
        onclick={openSettings}
        aria-label="Settings"
        aria-pressed={settingsOpen}
        use:tip={'Settings'}
      >
        <span class="codicon codicon-settings-gear"></span>
      </button>
    </div>
    <div class="shrink-0" style="border-top: 1px solid var(--vscode-panel-border);"></div>
    <TaskHistoryList
      variant="full"
      onSelect={(id) => { selectTask(id); historyOpen = false; }}
      onDelete={deleteTask}
      onRename={renameTask}
    />
  </div>
{:else}
  <div class="flex-1 min-h-0 flex flex-col relative">
    <!-- Toolbar only: Back | History + New task + Settings (task title lives in status card) -->
    <div
      class="shrink-0 border-b flex items-center gap-2 px-3 py-1 text-xs"
      style="border-color: var(--vscode-panel-border); background: var(--vscode-sideBar-background, transparent);"
    >
      <button
        type="button"
        class="icon-btn"
        style="width: 22px; height: 22px;"
        onclick={backToList}
        aria-label="Back to tasks list"
        use:tip={'Back to tasks list'}
      >
        <span class="codicon codicon-arrow-left"></span>
      </button>

      <div class="flex-1"></div>

      <button
        type="button"
        class="icon-btn"
        style="width: 22px; height: 22px;"
        onclick={() => (historyOpen = !historyOpen)}
        aria-label="History (previous coordinator tasks)"
        use:tip={'History (previous coordinator tasks)'}
      >
        <span class="codicon codicon-history"></span>
      </button>

      <button
        type="button"
        class="icon-btn"
        style="width: 22px; height: 22px;"
        onclick={() => { tasks.openNewTaskDraft(); post({ type: 'newTask' }); historyOpen = false; }}
        aria-label="New task"
        use:tip={'New task'}
      >
        <span class="codicon codicon-add"></span>
      </button>

      <button
        type="button"
        class="icon-btn"
        style="width: 22px; height: 22px;"
        onclick={openSettings}
        aria-label="Settings"
        aria-pressed={settingsOpen}
        use:tip={'Settings'}
      >
        <span class="codicon codicon-settings-gear"></span>
      </button>
    </div>

    <TaskWorkspace {pendingAsk} {activeTurnId} />

    <!-- History dropdown -->
    {#if historyOpen}
      <!-- click outside catcher -->
      <button
        type="button"
        aria-label="Close history"
        class="absolute left-0 right-0 bottom-0 top-[28px] z-40 cursor-default"
        style="background: transparent; border: none;"
        onclick={() => (historyOpen = false)}
      ></button>
      <div
        class="absolute right-3 top-[28px] z-50 w-80 max-w-[min(20rem,calc(100%-1rem))] max-h-[min(55vh,320px)] overflow-auto rounded border shadow"
        style="background: var(--vscode-editor-background); border-color: var(--vscode-panel-border);"
      >
        <div class="flex items-center justify-between px-2 py-1 border-b text-xs" style="border-color: var(--vscode-panel-border);">
          <span class="font-medium">Previous tasks</span>
          <button type="button" class="underline text-xs" onclick={() => { clearHistory(); }}>Clear</button>
        </div>
        <TaskHistoryList variant="dropdown" onSelect={(id) => { selectTask(id); }} />
      </div>
    {/if}
  </div>
{/if}