<script lang="ts">
  import { onMount } from 'svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import TaskHistoryList from './components/TaskList.svelte';
  import TaskWorkspace from './components/TaskWorkspace.svelte';
  import PermissionCard from './components/PermissionCard.svelte';
  import ElicitationFormCard from './components/ElicitationFormCard.svelte';
  import ElicitationUrlCard from './components/ElicitationUrlCard.svelte';
  import { tasks } from './lib/tasks.svelte';
  import { threadStore } from './lib/thread.svelte';
  import {
    effectiveRuntimeActivity,
    formatExportResultMessage,
    isExtMessage,
    isProtocolCompatible,
    isTaskScopedBannerVisible,
    post,
  } from './lib/protocol';
  import type {
    PendingAsk,
    PendingPermission,
    PermissionModeSetting,
    PermissionSettingsSnapshot,
    PermissionSettingsUpdateResult,
    RetentionSettingId,
    RetentionSettingSnapshot,
    SettingsUpdateResult,
    TaskTypeSettingsRow,
    TaskTypesSettingsSnapshot,
    TaskTypesSettingsUpdateResult,
  } from './lib/protocol';
  import { tip } from './lib/tooltip';
  import { outboxList, outboxMarkRejected, outboxPending, outboxRejected, outboxRemove } from './lib/send-outbox';
  import { selectTask as navSelectTask } from './lib/task-nav';
  import {
    SETTINGS_VIEW_STATE_VERSION,
    applyPermissionSnapshotToDraft,
    applyRetentionSnapshotToDrafts,
    applyTaskTypesSnapshotToDrafts,
    cloneRetentionDrafts,
    cloneTaskTypeDrafts,
    createEmptyRetentionDrafts,
    isPermissionDraftDirty,
    isRetentionDraftsDirty,
    isTaskTypeDraftsDirty,
    readSettingsViewState,
    reducePermissionSettingsUpdateResult,
    reduceRetentionUpdateResult,
    writeSettingsViewState,
    type RetentionDrafts,
  } from './lib/settings-view-state';
  import type { SettingsTopicId } from './lib/settings-topics';
  import { vscode } from './lib/vscode';

  type PendingElicitation =
    | {
        kind: 'form';
        promptId: string;
        message: string;
        fields: Array<Record<string, unknown>>;
        required: string[];
        askLike?: boolean;
        submissionError?: string;
        submissionVersion?: number;
      }
    | {
        kind: 'url';
        promptId: string;
        elicitationId: string;
        url: string;
        message: string;
        waiting?: boolean;
        submissionError?: string;
        submissionVersion?: number;
      };

  let pendingAsk = $state<PendingAsk | null>(null);
  let askSubmissionError = $state<string | undefined>(undefined);
  let askSubmissionVersion = $state(0);
  let pendingPermission = $state<PendingPermission | null>(null);
  let pendingElicitations = $state<PendingElicitation[]>([]);
  let activeTurnId = $state<string | null>(null);
  const visibleCommandError = $derived(
    tasks.commandError &&
      isTaskScopedBannerVisible(tasks.commandError.taskId, tasks.focusedTaskId)
      ? tasks.commandError
      : null,
  );
  const visibleCommandNotice = $derived(
    tasks.commandNotice &&
      isTaskScopedBannerVisible(tasks.commandNotice.taskId, tasks.focusedTaskId)
      ? tasks.commandNotice
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
  /** Retention-local success banner (never shown on Task Types). */
  let retentionSavedMessage = $state<string | null>(null);
  /** Retention-local alert for host write/load failures (never shown on Task Types). */
  let retentionError = $state<string | null>(null);
  /** Host-side field errors for Retention (validation codes from settingsUpdateResult). */
  let retentionFieldErrors = $state<Partial<Record<RetentionSettingId, string>>>({});
  let taskTypesSnapshot = $state<TaskTypesSettingsSnapshot | null>(null);
  let taskTypesLoading = $state(false);
  let taskTypesSaving = $state(false);
  let taskTypesSavedMessage = $state<string | null>(null);
  let taskTypesError = $state<string | null>(null);
  /** After a successful host write, the next snapshot must win even if drafts still look dirty. */
  let taskTypesForceHydrate = $state(false);
  let permissionSettingsSnapshot = $state<PermissionSettingsSnapshot | null>(null);
  let permissionSettingsLoading = $state(false);
  let permissionSettingsSaving = $state(false);
  let permissionSettingsSavedMessage = $state<string | null>(null);
  let permissionSettingsError = $state<string | null>(null);
  /** After a successful host write, the next snapshot must win even if draft still looks dirty. */
  let permissionSettingsForceHydrate = $state(false);

  // App-owned Settings drafts + navigation (survive close/reopen and hide/reveal).
  // Restored once from vscode.getState; subsequent edits persist via writeSettingsViewState.
  const restoredSettingsView = readSettingsViewState(vscode);
  let settingsActiveTopicId = $state<SettingsTopicId>(restoredSettingsView.activeTopicId);
  /**
   * undefined = not yet initialized from a host snapshot (and nothing restored).
   * object = owned draft, including restored dirty values or pristine snapshot copy.
   */
  let retentionDrafts = $state<RetentionDrafts | undefined>(
    restoredSettingsView.retentionDrafts
      ? cloneRetentionDrafts(restoredSettingsView.retentionDrafts)
      : undefined,
  );
  /** undefined = not yet initialized from a host snapshot; array (incl. empty) = owned draft. */
  let taskTypeDrafts = $state<TaskTypeSettingsRow[] | undefined>(
    restoredSettingsView.taskTypeDrafts
      ? cloneTaskTypeDrafts(restoredSettingsView.taskTypeDrafts)
      : undefined,
  );
  /** undefined = not yet initialized from a host snapshot; mode string = owned draft. */
  let permissionDraftMode = $state<PermissionModeSetting | undefined>(
    restoredSettingsView.permissionDraftMode,
  );
  let retentionLocalFieldErrors = $state<Partial<Record<RetentionSettingId, string>>>({});
  let taskTypesDraftError = $state<string | null>(null);

  function persistSettingsViewState() {
    const envelope: {
      v: typeof SETTINGS_VIEW_STATE_VERSION;
      activeTopicId: SettingsTopicId;
      taskTypeDrafts?: TaskTypeSettingsRow[];
      retentionDrafts?: RetentionDrafts;
      permissionDraftMode?: PermissionModeSetting;
    } = {
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: settingsActiveTopicId,
    };
    // Persist drafts only when owned so we never write empty placeholders that
    // would look dirty after restore against a later snapshot.
    if (taskTypeDrafts !== undefined) {
      envelope.taskTypeDrafts = cloneTaskTypeDrafts(taskTypeDrafts);
    }
    if (retentionDrafts !== undefined) {
      const dirty =
        !settingsSnapshot || isRetentionDraftsDirty(retentionDrafts, settingsSnapshot);
      if (dirty) {
        envelope.retentionDrafts = cloneRetentionDrafts(retentionDrafts);
      }
    }
    if (permissionDraftMode !== undefined) {
      const dirty =
        !permissionSettingsSnapshot ||
        isPermissionDraftDirty(permissionDraftMode, permissionSettingsSnapshot);
      if (dirty) {
        envelope.permissionDraftMode = permissionDraftMode;
      }
    }
    writeSettingsViewState(vscode, envelope);
  }

  function setSettingsActiveTopicId(topicId: SettingsTopicId) {
    settingsActiveTopicId = topicId;
    persistSettingsViewState();
  }

  function setRetentionDrafts(next: RetentionDrafts) {
    retentionDrafts = cloneRetentionDrafts(next);
    persistSettingsViewState();
  }

  function setTaskTypeDrafts(next: TaskTypeSettingsRow[]) {
    taskTypeDrafts = cloneTaskTypeDrafts(next);
    taskTypesDraftError = null;
    persistSettingsViewState();
  }

  function setPermissionDraftMode(next: PermissionModeSetting) {
    permissionDraftMode = next;
    permissionSettingsSavedMessage = null;
    // Selecting a mode is draft-only — never post until explicit Save.
    persistSettingsViewState();
  }

  function setRetentionLocalFieldErrors(next: Partial<Record<RetentionSettingId, string>>) {
    retentionLocalFieldErrors = { ...next };
  }

  function setTaskTypesDraftError(message: string | null) {
    taskTypesDraftError = message;
  }

  function selectTask(taskId: string) {
    navSelectTask(taskId);
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
    // Keep Retention feedback scoped; do not clear dirty drafts on open.
    retentionError = null;
    retentionSavedMessage = null;
    retentionFieldErrors = {};
    taskTypesLoading = !taskTypesSnapshot;
    taskTypesError = null;
    taskTypesSavedMessage = null;
    permissionSettingsLoading = !permissionSettingsSnapshot;
    permissionSettingsError = null;
    permissionSettingsSavedMessage = null;
    post({ type: 'requestSettings' });
    post({ type: 'requestTaskTypesSettings' });
    post({ type: 'requestPermissionSettings' });
    post({ type: 'listBackends' });
    post({ type: 'listModels' });
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

    const next = reduceRetentionUpdateResult(
      {
        drafts: retentionDrafts ?? createEmptyRetentionDrafts(),
        fieldErrors: retentionFieldErrors,
        localFieldErrors: retentionLocalFieldErrors,
      },
      result,
    );

    // On host write failure: keep attempted draft, keep prior saved snapshot authoritative.
    // Never rehydrate inputs back to saved merely because an error arrived.
    retentionDrafts = next.drafts;
    retentionFieldErrors = next.fieldErrors;
    retentionLocalFieldErrors = next.localFieldErrors;
    retentionError = next.error;
    retentionSavedMessage = next.savedMessage;

    if (next.confirmed) {
      updateSnapshotValue(next.confirmed.settingId, next.confirmed.value);
      persistSettingsViewState();
    }
    // Failure path intentionally does not touch Task Types state or force draft rehydrate.
  }

  function saveSetting(settingId: RetentionSettingId, value: number) {
    settingsSavingSettingId = settingId;
    retentionSavedMessage = null;
    retentionError = null;
    retentionFieldErrors = { ...retentionFieldErrors, [settingId]: undefined };
    post({ type: 'updateSetting', settingId, value });
  }

  function applyTaskTypesUpdateResult(result: TaskTypesSettingsUpdateResult) {
    taskTypesSaving = false;
    taskTypesLoading = false;
    if (result.ok) {
      // Force the following snapshot to replace drafts so Reset/Save clear dirty only after host success.
      taskTypesForceHydrate = true;
      taskTypesError = null;
      taskTypesSavedMessage = 'Saved task types to workspace settings.';
      return;
    }
    // Failure: keep drafts + prior saved snapshot; never force-hydrate from a stale host read.
    taskTypesForceHydrate = false;
    taskTypesSavedMessage = null;
    const diag = result.diagnostics?.[0]?.message;
    taskTypesError = diag ?? result.message;
  }

  function saveTaskTypes(types: TaskTypeSettingsRow[]) {
    taskTypesSaving = true;
    taskTypesSavedMessage = null;
    taskTypesError = null;
    post({ type: 'updateTaskTypes', types });
  }

  function resetTaskTypesToDefaults() {
    if (!taskTypesSnapshot) return;
    // Explicit host update only — do not clear dirty drafts until success + snapshot.
    saveTaskTypes(taskTypesSnapshot.defaults.map((t) => ({ ...t })));
  }

  function applyPermissionSettingsUpdateResult(result: PermissionSettingsUpdateResult) {
    permissionSettingsSaving = false;
    permissionSettingsLoading = false;
    const next = reducePermissionSettingsUpdateResult(
      { draftMode: permissionDraftMode ?? permissionSettingsSnapshot?.mode ?? 'ask' },
      result,
    );
    permissionDraftMode = next.draftMode;
    permissionSettingsError = next.error;
    permissionSettingsSavedMessage = next.savedMessage;
    if (next.confirmed) {
      // Force the following snapshot to replace draft so dirty clears only after host success.
      permissionSettingsForceHydrate = true;
      if (permissionSettingsSnapshot) {
        permissionSettingsSnapshot = {
          ...permissionSettingsSnapshot,
          mode: next.confirmed.mode,
        };
      }
      persistSettingsViewState();
      return;
    }
    // Failure: keep attempted draft + prior saved snapshot; never force-hydrate.
    permissionSettingsForceHydrate = false;
    persistSettingsViewState();
  }

  function savePermissionSettings() {
    if (permissionDraftMode === undefined) return;
    permissionSettingsSaving = true;
    permissionSettingsSavedMessage = null;
    permissionSettingsError = null;
    post({ type: 'updatePermissionSettings', mode: permissionDraftMode });
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
          askSubmissionError = undefined;
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
          // Phase C: replay pending (not rejected) outbox only after compatible snapshot.
          if (!outboxReplayed && !protocolMismatch) {
            outboxReplayed = true;
            for (const entry of outboxPending(vscode)) {
              post({
                type: 'send',
                taskId: entry.taskId,
                text: entry.text,
                llmText: entry.llmText,
                backend: entry.backend,
                model: entry.model,
                continuationOf: entry.continuationOf,
                clientRequestId: entry.clientRequestId,
              });
            }
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

        case 'settingsSnapshot': {
          const next = msg.snapshot;
          // Preserve owned drafts only when they already differ from saved/incoming.
          // Uninitialized (undefined) drafts always hydrate from the snapshot.
          // A later host snapshot may refresh saved state but cannot overwrite a dirty draft.
          const dirtyAgainstIncoming =
            retentionDrafts !== undefined &&
            (isRetentionDraftsDirty(retentionDrafts, settingsSnapshot) ||
              isRetentionDraftsDirty(retentionDrafts, next));
          settingsSnapshot = next;
          settingsLoading = false;
          // Preserve Retention-local failure banners across incidental snapshots
          // (mirrors Task Types). Success path already cleared error via update result.
          retentionDrafts = applyRetentionSnapshotToDrafts(
            retentionDrafts,
            next,
            dirtyAgainstIncoming,
          );
          persistSettingsViewState();
          break;
        }

        case 'settingsUpdateResult':
          applySettingsUpdateResult(msg.result);
          break;

        case 'taskTypesSettingsSnapshot': {
          const next = msg.snapshot;
          const forceHydrate = taskTypesForceHydrate;
          taskTypesForceHydrate = false;
          const dirtyAgainstIncoming =
            !forceHydrate &&
            taskTypeDrafts !== undefined &&
            (isTaskTypeDraftsDirty(taskTypeDrafts, taskTypesSnapshot?.types ?? null) ||
              isTaskTypeDraftsDirty(taskTypeDrafts, next.types));
          taskTypesSnapshot = next;
          taskTypesLoading = false;
          // Preserve save/reset failure banners across incidental snapshots.
          // Success path already cleared error and set saved message before force-hydrate.
          taskTypeDrafts = applyTaskTypesSnapshotToDrafts(
            taskTypeDrafts,
            next.types,
            dirtyAgainstIncoming,
          );
          persistSettingsViewState();
          break;
        }

        case 'taskTypesSettingsUpdateResult':
          applyTaskTypesUpdateResult(msg.result);
          break;

        case 'permissionSettingsSnapshot': {
          const next = msg.snapshot;
          const forceHydrate = permissionSettingsForceHydrate;
          permissionSettingsForceHydrate = false;
          const dirtyAgainstIncoming =
            !forceHydrate &&
            permissionDraftMode !== undefined &&
            (isPermissionDraftDirty(permissionDraftMode, permissionSettingsSnapshot) ||
              isPermissionDraftDirty(permissionDraftMode, next));
          permissionSettingsSnapshot = next;
          permissionSettingsLoading = false;
          // Preserve Permissions-local failure banners across incidental snapshots.
          // Success path already cleared error and set saved message before force-hydrate.
          permissionDraftMode = applyPermissionSnapshotToDraft(
            permissionDraftMode,
            next,
            dirtyAgainstIncoming,
          );
          persistSettingsViewState();
          break;
        }

        case 'permissionSettingsUpdateResult':
          applyPermissionSettingsUpdateResult(msg.result);
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
          // Never auto-focus another task (owning-root makes siblings known).
          // Tree attention counts surface needs-you; user opens via tree nav.
          if (msg.taskId === tasks.focusedTaskId) {
            pendingAsk = {
              turnId: msg.turnId,
              askId: msg.askId,
              questions: msg.questions,
            };
            askSubmissionError = undefined;
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
            askSubmissionError = undefined;
          }
          break;

        case 'askSubmissionResult':
          if (
            !msg.ok &&
            pendingAsk?.askId === msg.askId &&
            pendingAsk.turnId === msg.turnId &&
            msg.taskId === tasks.focusedTaskId
          ) {
            askSubmissionError = msg.message ?? 'The answer could not be delivered. Please try again.';
            askSubmissionVersion += 1;
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

        case 'elicitationFormPending': {
          const existingForm = pendingElicitations.find((p) => p.promptId === msg.promptId);
          pendingElicitations = [
            ...pendingElicitations.filter((p) => p.promptId !== msg.promptId),
            {
              kind: 'form',
              promptId: msg.promptId,
              message: msg.message,
              fields: msg.fields,
              required: msg.required,
              askLike: msg.askLike,
              // Preserve unlock state across snapshot/replay of the same prompt.
              submissionError: existingForm?.submissionError,
              submissionVersion: existingForm?.submissionVersion,
            },
          ];
          break;
        }

        case 'elicitationUrlPending': {
          const existingUrl = pendingElicitations.find((p) => p.promptId === msg.promptId);
          pendingElicitations = [
            ...pendingElicitations.filter((p) => p.promptId !== msg.promptId),
            {
              kind: 'url',
              promptId: msg.promptId,
              elicitationId: msg.elicitationId,
              url: msg.url,
              message: msg.message,
              // Preserve unlock state across snapshot/replay of the same prompt.
              submissionError: existingUrl?.submissionError,
              submissionVersion: existingUrl?.submissionVersion,
              waiting: existingUrl?.kind === 'url' ? existingUrl.waiting : undefined,
            },
          ];
          break;
        }

        case 'elicitationUrlWaiting':
          pendingElicitations = pendingElicitations.map((p) =>
            p.promptId === msg.promptId && p.kind === 'url'
              ? { ...p, waiting: true, message: msg.message ?? p.message }
              : p,
          );
          break;

        case 'elicitationCleared':
          pendingElicitations = pendingElicitations.filter((p) => p.promptId !== msg.promptId);
          break;

        case 'elicitationSubmissionResult':
          pendingElicitations = pendingElicitations.map((p) => {
            if (p.promptId !== msg.promptId) return p;
            if (!msg.ok) {
              return {
                ...p,
                submissionError: msg.message ?? 'The response could not be delivered. Please try again.',
                submissionVersion: (p.submissionVersion ?? 0) + 1,
              };
            }
            // URL accept keeps the card mounted in waiting state — clear stale rejection text.
            return { ...p, submissionError: undefined };
          });
          break;

        case 'commandError':
          if (isTaskScopedBannerVisible(msg.taskId, tasks.focusedTaskId)) {
            tasks.setCommandError(msg.message, msg.taskId ?? null);
          }
          break;

        case 'sendAccepted':
          outboxRemove(vscode, msg.clientRequestId);
          break;

        case 'sendRejected': {
          const rejected = outboxMarkRejected(vscode, msg.clientRequestId);
          if (rejected?.text) {
            const sameScope =
              (!rejected.taskId && tasks.draftMode) ||
              (!!rejected.taskId && rejected.taskId === tasks.focusedTaskId);
            if (sameScope) {
              tasks.prefillComposer(
                rejected.text,
                rejected.clientRequestId,
                rejected.mentionBindings,
                rejected.skills,
                rejected.backend,
              );
            }
            // Outbox stays until muster:prefill-applied confirms restore.
          } else {
            outboxRemove(vscode, msg.clientRequestId);
          }
          if (isTaskScopedBannerVisible(msg.taskId, tasks.focusedTaskId)) {
            tasks.setCommandError(msg.reason, msg.taskId ?? null);
          }
          break;
        }

        case 'exportResult':
          // Success notice is task-scoped; basename-only fileName + sourceRevision.
          // Failures use commandError; cancel posts nothing from the host.
          if (isTaskScopedBannerVisible(msg.taskId, tasks.focusedTaskId)) {
            tasks.setCommandNotice(
              formatExportResultMessage(msg.fileName, msg.sourceRevision),
              msg.taskId,
            );
          }
          break;

        case 'backendsAvailable':
          tasks.setAvailableBackends(msg.backends);
          break;

        case 'modelsAvailable':
          tasks.setAvailableModels(msg.models);
          break;

        case 'composerSelection':
          tasks.applyHostComposerSelection(msg.backend, msg.model);
          break;
      }
    }

    function onPrefillApplied(e: Event) {
      const id = (e as CustomEvent<{ clientRequestId?: string }>).detail?.clientRequestId;
      if (typeof id === 'string' && id) {
        outboxRemove(vscode, id);
      }
    }

    window.addEventListener('message', onMessage);
    window.addEventListener('muster:prefill-applied', onPrefillApplied);
    // Ask the host which backends are installed so the picker only offers them.
    post({ type: 'listBackends' });
    // Prefetch model lists for the New-task picker (host also prefetches on resolve).
    post({ type: 'listModels' });
    // Phase C outbox replay happens after a compatible snapshot (see below).
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('muster:prefill-applied', onPrefillApplied);
    };
  });

  let outboxReplayed = false;

  // After focus changes, restore only rejected drafts (never pending ACK entries).
  $effect(() => {
    void tasks.focusedTaskId;
    void tasks.draftMode;
    const rejected = outboxRejected(vscode);
    if (rejected.length === 0) return;
    // One at a time to avoid stomping composerPrefill.
    const entry = rejected.find((e) => {
      if (!e.text) return false;
      return (
        (!e.taskId && tasks.draftMode) || (!!e.taskId && e.taskId === tasks.focusedTaskId)
      );
    });
    if (!entry) return;
    if (tasks.composerPrefill?.clientRequestId === entry.clientRequestId) return;
    tasks.prefillComposer(
      entry.text,
      entry.clientRequestId,
      entry.mentionBindings,
      entry.skills,
      entry.backend,
    );
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
    savedMessage={retentionSavedMessage}
    retentionError={retentionError}
    fieldErrors={retentionFieldErrors}
    localFieldErrors={retentionLocalFieldErrors}
    retentionDrafts={retentionDrafts ?? createEmptyRetentionDrafts()}
    onRetentionDraftsChange={setRetentionDrafts}
    onLocalFieldErrorsChange={setRetentionLocalFieldErrors}
    onSave={saveSetting}
    taskTypesSnapshot={taskTypesSnapshot}
    taskTypesLoading={taskTypesLoading}
    taskTypesSaving={taskTypesSaving}
    taskTypesSavedMessage={taskTypesSavedMessage}
    taskTypesError={taskTypesError}
    taskTypeDrafts={taskTypeDrafts ?? []}
    taskTypesDraftError={taskTypesDraftError}
    onTaskTypeDraftsChange={setTaskTypeDrafts}
    onTaskTypesDraftErrorChange={setTaskTypesDraftError}
    permissionSettingsSnapshot={permissionSettingsSnapshot}
    permissionSettingsLoading={permissionSettingsLoading}
    permissionSettingsSaving={permissionSettingsSaving}
    permissionSettingsSavedMessage={permissionSettingsSavedMessage}
    permissionSettingsError={permissionSettingsError}
    permissionDraftMode={permissionDraftMode}
    onPermissionDraftModeChange={setPermissionDraftMode}
    onSavePermissionSettings={savePermissionSettings}
    activeTopicId={settingsActiveTopicId}
    onActiveTopicIdChange={setSettingsActiveTopicId}
    availableBackends={tasks.availableBackends ?? []}
    modelsByBackend={tasks.modelsByBackend ?? {}}
    onSaveTaskTypes={saveTaskTypes}
    onResetTaskTypes={resetTaskTypesToDefaults}
  />
{:else}
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

{#if visibleCommandNotice}
  <div class="task-command-notice" role="status">
    <div class="min-w-0">
      <div class="font-semibold">Status</div>
      <div class="task-command-notice__detail">{visibleCommandNotice.message}</div>
    </div>
    <button
      type="button"
      class="task-command-notice__dismiss"
      onclick={() => tasks.setCommandNotice(null)}
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

{#each pendingElicitations as pe (pe.promptId)}
  {#if pe.kind === 'form'}
    <ElicitationFormCard
      promptId={pe.promptId}
      message={pe.message}
      fields={pe.fields as Array<{
        key: string;
        type: string;
        title?: string;
        description?: string;
        options?: string[];
        required?: boolean;
        default?: unknown;
      }>}
      required={pe.required}
      askLike={pe.askLike}
      submissionError={pe.submissionError}
      submissionVersion={pe.submissionVersion}
    />
  {:else}
    <ElicitationUrlCard
      promptId={pe.promptId}
      elicitationId={pe.elicitationId}
      url={pe.url}
      message={pe.message}
      waiting={pe.waiting}
      submissionError={pe.submissionError}
      submissionVersion={pe.submissionVersion}
    />
  {/if}
{/each}

{#if !inChat}
  <!-- Entry: New task action, then the searchable previous-tasks list.
       Sidebar background across the whole entry so the New-task header shares one
       light surface with the list below (matching the MUSTER view-title bar). -->
  <div class="flex-1 min-h-0 flex flex-col" style="background: var(--vscode-sideBar-background);">
    <div class="shrink-0 flex items-center hover:bg-[var(--vscode-list-hoverBackground)]">
      <button
        type="button"
        class="flex-1 flex items-center gap-2 px-3 py-2 text-sm font-medium text-left"
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
    <!-- Toolbar only: Back | History + New task + Settings (task context lives in tree chrome) -->
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
        aria-label="Export task/chat"
        data-testid="export-task-chat"
        use:tip={'Export task/chat'}
        disabled={!tasks.focusedTaskId}
        onclick={() => {
          if (!tasks.focusedTaskId) return;
          tasks.setCommandError(null);
          post({ type: 'exportTask', taskId: tasks.focusedTaskId });
        }}
      >
        <span class="codicon codicon-export"></span>
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

    <TaskWorkspace
      {pendingAsk}
      {activeTurnId}
      submissionError={askSubmissionError}
      submissionVersion={askSubmissionVersion}
    />

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
{/if}
