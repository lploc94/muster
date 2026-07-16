<script lang="ts">
  import { tick } from 'svelte';
  import Select from './Select.svelte';
  import type {
    PermissionModeSetting,
    PermissionSettingsSnapshot,
    RuntimeStorageSettingId,
    RuntimeStorageSettingsSnapshot,
    RunLimitSetting,
    TaskTypeSettingsRow,
    TaskTypesSettingsSnapshot,
  } from '../lib/protocol';
  import {
    SETTINGS_TOPICS,
    type SettingsTopicId,
    getSettingsTopic,
    resolveSettingsTabKeyIntent,
    settingsPanelId,
    settingsTabId,
  } from '../lib/settings-topics';
  import {
    PERMISSION_MODE_RISK_LABELS,
    RETENTION_SETTING_LABELS,
    isPermissionDraftDirty,
    isRetentionDraftsDirty,
    isTaskTypeDraftsDirty,
    retentionDraftValidationMessage,
    retentionTabIndicator,
    permissionTabIndicator,
    type RetentionDrafts,
  } from '../lib/settings-view-state';

  interface Props {
    onClose: () => void;
    snapshot: RuntimeStorageSettingsSnapshot | null;
    loading: boolean;
    savingSettingId: RuntimeStorageSettingId | null;
    savedMessage: string | null;
    /** Retention-local host write/load failure (never shown on Task Types). */
    retentionError: string | null;
    fieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
    /** App-owned client-side field errors (validation). */
    localFieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
    /** App-owned Retention draft strings. */
    retentionDrafts: RetentionDrafts;
    onRetentionDraftsChange: (drafts: RetentionDrafts) => void;
    onLocalFieldErrorsChange: (errors: Partial<Record<RuntimeStorageSettingId, string>>) => void;
    onSave: (settingId: RuntimeStorageSettingId, value: number | RunLimitSetting) => void;
    /** Task types (muster.taskTypes) */
    taskTypesSnapshot: TaskTypesSettingsSnapshot | null;
    taskTypesLoading: boolean;
    taskTypesSaving: boolean;
    taskTypesSavedMessage: string | null;
    taskTypesError: string | null;
    /** App-owned Task Types draft rows (survives unmount / tab switch). */
    taskTypeDrafts: TaskTypeSettingsRow[];
    taskTypesDraftError: string | null;
    onTaskTypeDraftsChange: (drafts: TaskTypeSettingsRow[]) => void;
    onTaskTypesDraftErrorChange: (message: string | null) => void;
    /** App-owned active topic (persisted via settings view state). */
    activeTopicId: SettingsTopicId;
    onActiveTopicIdChange: (topicId: SettingsTopicId) => void;
    availableBackends: string[];
    modelsByBackend: Record<string, { current?: string; options: { value: string; name: string }[] }>;
    onSaveTaskTypes: (types: TaskTypeSettingsRow[]) => void;
    onResetTaskTypes: () => void;
    /** Permissions (muster.permissions.mode) — configuration only, not runtime prompts. */
    permissionSettingsSnapshot: PermissionSettingsSnapshot | null;
    permissionSettingsLoading: boolean;
    permissionSettingsSaving: boolean;
    permissionSettingsSavedMessage: string | null;
    permissionSettingsError: string | null;
    /** App-owned draft mode (undefined until host snapshot or restore). */
    permissionDraftMode: PermissionModeSetting | undefined;
    onPermissionDraftModeChange: (mode: PermissionModeSetting) => void;
    onSavePermissionSettings: () => void;
  }

  const TASK_TYPE_STATUS_LABEL: Record<TaskTypesSettingsSnapshot['status'], string> = {
    ok: 'Valid',
    empty: 'Empty',
    invalid: 'Invalid',
  };

  /** Runtime prompts stay separate from this configuration surface. */
  const PERMISSIONS_RUNTIME_NOTE =
    'Runtime permission prompts still appear as in-session permission cards when a turn needs approval. This tab only configures the default policy mode.';

  /** Honest scope: custom editor writes workspace-level map only. */
  const TASK_TYPES_WORKSPACE_SCOPE_COPY =
    'This editor saves the workspace-level muster.taskTypes map (workspace settings.json). Folder-specific resource overrides remain in native VS Code Settings and are not edited here.';

  let {
    onClose,
    snapshot,
    loading,
    savingSettingId,
    savedMessage,
    retentionError,
    fieldErrors,
    localFieldErrors,
    retentionDrafts,
    onRetentionDraftsChange,
    onLocalFieldErrorsChange,
    onSave,
    taskTypesSnapshot,
    taskTypesLoading,
    taskTypesSaving,
    taskTypesSavedMessage,
    taskTypesError,
    taskTypeDrafts,
    taskTypesDraftError,
    onTaskTypeDraftsChange,
    onTaskTypesDraftErrorChange,
    permissionSettingsSnapshot,
    permissionSettingsLoading,
    permissionSettingsSaving,
    permissionSettingsSavedMessage,
    permissionSettingsError,
    permissionDraftMode,
    onPermissionDraftModeChange,
    onSavePermissionSettings,
    activeTopicId,
    onActiveTopicIdChange,
    availableBackends,
    modelsByBackend,
    onSaveTaskTypes,
    onResetTaskTypes,
  }: Props = $props();

  let tablistEl = $state<HTMLDivElement | null>(null);

  function displayLabel(settingId: RuntimeStorageSettingId): string {
    return RETENTION_SETTING_LABELS[settingId];
  }

  function fieldId(settingId: RuntimeStorageSettingId): string {
    return `settings-${settingId}`;
  }

  function updateDraft(settingId: RuntimeStorageSettingId, value: string) {
    onRetentionDraftsChange({ ...retentionDrafts, [settingId]: value });
    onLocalFieldErrorsChange({ ...localFieldErrors, [settingId]: undefined });
  }

  function onDraftInput(settingId: RuntimeStorageSettingId, event: Event) {
    updateDraft(settingId, (event.currentTarget as HTMLInputElement).value);
  }

  function validationMessage(settingId: RuntimeStorageSettingId, minimum = 0): string | null {
    return retentionDraftValidationMessage(
      settingId,
      retentionDrafts[settingId] ?? '',
      minimum,
      displayLabel(settingId),
    );
  }

  function saveSetting(settingId: RuntimeStorageSettingId, minimum = 0) {
    const message = validationMessage(settingId, minimum);
    if (message) {
      // Invalid drafts remain visible and send no update.
      onLocalFieldErrorsChange({ ...localFieldErrors, [settingId]: message });
      return;
    }

    onLocalFieldErrorsChange({ ...localFieldErrors, [settingId]: undefined });
    onSave(
      settingId,
      settingId === 'runLimit'
        ? retentionDrafts[settingId] as RunLimitSetting
        : Number(retentionDrafts[settingId]),
    );
  }

  function backendOptions(): string[] {
    const fromCatalog = availableBackends.length > 0 ? availableBackends : [];
    const fromDrafts = taskTypeDrafts.map((t) => t.backend).filter(Boolean);
    return [...new Set([...fromCatalog, ...fromDrafts, 'claude', 'codex', 'grok', 'kiro', 'opencode'])];
  }

  function modelOptions(backend: string, pinnedModel?: string): { value: string; name: string }[] {
    const catalog = modelsByBackend[backend]?.options ?? [];
    if (!pinnedModel || pinnedModel.trim().length === 0) return catalog;
    if (catalog.some((o) => o.value === pinnedModel)) return catalog;
    // Preserve valid host-backed pins missing from the live catalog.
    return [{ value: pinnedModel, name: `${pinnedModel} (saved)` }, ...catalog];
  }

  function updateTypeRow(index: number, patch: Partial<TaskTypeSettingsRow>) {
    onTaskTypeDraftsChange(
      taskTypeDrafts.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function removeTypeRow(index: number) {
    onTaskTypeDraftsChange(taskTypeDrafts.filter((_, i) => i !== index));
  }

  function addTypeRow() {
    const max = taskTypesSnapshot?.constraints.maxTypes ?? 32;
    if (taskTypeDrafts.length >= max) {
      onTaskTypesDraftErrorChange(`At most ${max} task types.`);
      return;
    }
    onTaskTypeDraftsChange([
      ...taskTypeDrafts,
      {
        id: '',
        backend: availableBackends[0] ?? 'opencode',
        role: 'worker',
        briefKind: 'generic',
      },
    ]);
  }

  function validateTypeDrafts(): string | null {
    const c = taskTypesSnapshot?.constraints;
    let idRe = /^[a-z][a-z0-9_-]{0,63}$/;
    if (c?.idPattern) {
      try {
        idRe = new RegExp(c.idPattern);
      } catch {
        return 'Invalid type id pattern from host.';
      }
    }
    const descMax = c?.descriptionMax ?? 200;
    const seen = new Set<string>();
    for (const row of taskTypeDrafts) {
      if (!row.id.trim()) return 'Each type needs an id.';
      if (!idRe.test(row.id)) return `Invalid type id "${row.id}".`;
      if (seen.has(row.id)) return `Duplicate type id "${row.id}".`;
      seen.add(row.id);
      if (!row.backend.trim()) return `Type "${row.id}" needs a backend.`;
      if (row.description && row.description.length > descMax) {
        return `Description for "${row.id}" exceeds ${descMax} characters.`;
      }
    }
    return null;
  }

  function saveTypes() {
    const err = validateTypeDrafts();
    if (err) {
      onTaskTypesDraftErrorChange(err);
      return;
    }
    onTaskTypesDraftErrorChange(null);
    onSaveTaskTypes(
      taskTypeDrafts.map((row) => {
        const out: TaskTypeSettingsRow = {
          id: row.id.trim(),
          backend: row.backend.trim(),
          role: row.role,
          briefKind: row.briefKind,
        };
        if (row.model?.trim()) out.model = row.model.trim();
        if (row.description?.trim()) out.description = row.description.trim();
        return out;
      }),
    );
  }

  function resetTypes() {
    if (!taskTypesSnapshot) return;
    // Explicit host update only — drafts stay dirty until success + force-hydrate snapshot.
    // Do not replace drafts with defaults before the host confirms the write.
    onTaskTypesDraftErrorChange(null);
    onResetTaskTypes();
  }

  async function activateTopic(topicId: SettingsTopicId, options?: { focusTab?: boolean }) {
    onActiveTopicIdChange(topicId);
    // Two ticks so roving tabindex/selected attributes settle before focus restore.
    await tick();
    await tick();
    const tabId = settingsTabId(topicId);
    if (!tabId || !tablistEl) return;
    const tab = tablistEl.querySelector<HTMLElement>(`#${CSS.escape(tabId)}`);
    if (!tab) return;
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (options?.focusTab !== false) {
      tab.focus();
    }
  }

  function onTabClick(topicId: SettingsTopicId) {
    void activateTopic(topicId, { focusTab: true });
  }

  function onTabKeydown(event: KeyboardEvent) {
    const intent = resolveSettingsTabKeyIntent(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      },
      { activeTopicId },
    );
    if (intent.kind === 'none') return;
    event.preventDefault();
    void activateTopic(intent.topicId, { focusTab: true });
  }

  const activeTopic = $derived(getSettingsTopic(activeTopicId));
  const activeTabDomId = $derived(settingsTabId(activeTopicId) ?? '');
  const activePanelDomId = $derived(settingsPanelId(activeTopicId) ?? '');

  const taskTypesDirty = $derived(
    isTaskTypeDraftsDirty(taskTypeDrafts, taskTypesSnapshot?.types ?? null),
  );
  const taskTypesHasError = $derived(Boolean(taskTypesError || taskTypesDraftError));
  const taskTypesHasDiagnostics = $derived(
    Boolean(
      taskTypesSnapshot &&
        (taskTypesSnapshot.status !== 'ok' || taskTypesSnapshot.diagnostics.length > 0),
    ),
  );

  function taskTypesTabIndicator(): { kind: string; label: string } | null {
    if (taskTypesSaving) return { kind: 'saving', label: 'Saving' };
    if (taskTypesHasError) return { kind: 'error', label: 'Error' };
    if (taskTypesDirty) return { kind: 'dirty', label: 'Unsaved' };
    if (taskTypesSavedMessage) return { kind: 'saved', label: 'Saved' };
    if (taskTypesHasDiagnostics) return { kind: 'diagnostic', label: 'Needs attention' };
    return null;
  }

  const taskTypesIndicator = $derived(taskTypesTabIndicator());

  const retentionDirty = $derived(isRetentionDraftsDirty(retentionDrafts, snapshot));
  const retentionIndicator = $derived(
    retentionTabIndicator({
      saving: savingSettingId !== null,
      error: retentionError,
      fieldErrors,
      localFieldErrors,
      dirty: retentionDirty,
      savedMessage,
    }),
  );

  const permissionDirty = $derived(
    isPermissionDraftDirty(permissionDraftMode, permissionSettingsSnapshot),
  );
  const permissionIndicator = $derived(
    permissionTabIndicator({
      saving: permissionSettingsSaving,
      error: permissionSettingsError,
      dirty: permissionDirty,
      savedMessage: permissionSettingsSavedMessage,
    }),
  );

  function topicIndicator(topicId: SettingsTopicId): { kind: string; label: string } | null {
    if (topicId === 'task-types') return taskTypesIndicator;
    if (topicId === 'permissions') return permissionIndicator;
    if (topicId === 'retention') return retentionIndicator;
    return null;
  }
</script>

<section class="settings-panel" aria-labelledby="settings-panel-title">
  <div class="settings-panel__header">
    <div class="settings-panel__header-start">
      <button
        type="button"
        class="icon-btn settings-panel__back"
        onclick={onClose}
        aria-label="Back to tasks"
        title="Back to tasks"
      >
        <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
      </button>
      <div class="min-w-0">
        <h2 id="settings-panel-title" class="settings-panel__title">Settings</h2>
      </div>
    </div>
  </div>

  <div
    class="settings-panel__tabs"
    role="tablist"
    aria-label="Settings topics"
    bind:this={tablistEl}
  >
    {#each SETTINGS_TOPICS as topic (topic.id)}
      {@const tabId = settingsTabId(topic.id) ?? ''}
      {@const panelId = settingsPanelId(topic.id) ?? ''}
      {@const selected = activeTopicId === topic.id}
      {@const indicator = topicIndicator(topic.id)}
      <button
        type="button"
        class="settings-panel__tab"
        class:settings-panel__tab--selected={selected}
        class:settings-panel__tab--dirty={indicator?.kind === 'dirty'}
        class:settings-panel__tab--error={indicator?.kind === 'error'}
        class:settings-panel__tab--saving={indicator?.kind === 'saving'}
        class:settings-panel__tab--saved={indicator?.kind === 'saved'}
        class:settings-panel__tab--diagnostic={indicator?.kind === 'diagnostic'}
        role="tab"
        id={tabId}
        aria-selected={selected ? 'true' : 'false'}
        aria-controls={panelId}
        tabindex={selected ? 0 : -1}
        data-topic-id={topic.id}
        data-availability={topic.availability}
        data-tab-state={indicator?.kind ?? undefined}
        aria-label={indicator ? `${topic.label}, ${indicator.label}` : topic.label}
        onclick={() => onTabClick(topic.id)}
        onkeydown={onTabKeydown}
      >
        <span class="settings-panel__tab-label">{topic.label}</span>
        {#if indicator}
          <span
            class={`settings-panel__tab-indicator settings-panel__tab-indicator--${indicator.kind}`}
            data-testid={`settings-tab-indicator-${topic.id}`}
            aria-hidden="true"
          >{indicator.label}</span>
        {/if}
        {#if topic.availability === 'coming-soon'}
          <span class="settings-panel__tab-badge">Coming soon</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="settings-panel__body">
    <div class="settings-panel__body-inner">
      <div
        class="settings-panel__tabpanel"
        role="tabpanel"
        id={activePanelDomId}
        aria-labelledby={activeTabDomId}
        data-topic-id={activeTopicId}
        data-availability={activeTopic?.availability ?? 'active'}
        tabindex="0"
      >
        {#if activeTopicId === 'task-types'}
          <section class="settings-section" aria-label="Task types">
            <div class="settings-section__head">
              <div class="settings-section__heading">
                <h3 class="settings-section__title">Task Types</h3>
                <p class="settings-section__desc">
                  Map coordinator create/delegate to a backend and optional model.
                </p>
              </div>
              {#if taskTypesSnapshot}
                <div class="settings-section__actions">
                  <button
                    type="button"
                    class="settings-panel__btn settings-panel__btn--ghost"
                    disabled={taskTypesSaving}
                    onclick={addTypeRow}
                  >
                    <span class="codicon codicon-add" aria-hidden="true"></span>Add
                  </button>
                  <button
                    type="button"
                    class="settings-panel__btn settings-panel__btn--ghost"
                    disabled={taskTypesSaving}
                    onclick={resetTypes}
                  >Reset</button>
                  <button
                    type="button"
                    class="settings-panel__btn settings-panel__btn--primary"
                    disabled={taskTypesSaving}
                    onclick={saveTypes}
                  >{taskTypesSaving ? 'Saving…' : 'Save'}</button>
                </div>
              {/if}
            </div>

            <p
              class="settings-panel__hint settings-panel__scope-copy"
              data-testid="task-types-workspace-scope"
              role="note"
            >
              {TASK_TYPES_WORKSPACE_SCOPE_COPY}
            </p>

            {#if taskTypesLoading && !taskTypesSnapshot}
              <p class="settings-panel__notice" role="status">Loading task types…</p>
            {:else if taskTypesSnapshot}
              <div class="settings-section__status">
                <span class={`type-status type-status--${taskTypesSnapshot.status}`}>
                  <span class="type-status__dot" aria-hidden="true"></span>
                  {TASK_TYPE_STATUS_LABEL[taskTypesSnapshot.status]}
                </span>
                <span class="settings-section__count">
                  {taskTypeDrafts.length} of {taskTypesSnapshot.constraints.maxTypes} types
                </span>
                {#if taskTypesDirty}
                  <span class="settings-section__dirty" data-testid="task-types-dirty" role="status">Unsaved changes</span>
                {/if}
              </div>

              {#if taskTypesSnapshot.status === 'empty'}
                <div
                  class="settings-panel__notice"
                  role="status"
                  data-testid="task-types-diagnostic-empty"
                >
                  Host map is empty. Coordinator create/delegate fail closed until types are saved.
                  Use Reset for ship defaults or Add to define types, then Save to workspace settings.
                </div>
              {:else if taskTypesSnapshot.status === 'invalid'}
                <div
                  class="settings-panel__error settings-panel__diagnostics"
                  role="alert"
                  data-testid="task-types-diagnostic-invalid"
                >
                  <div class="settings-panel__error-title">Host task types are invalid</div>
                  <p class="settings-panel__description">
                    The saved workspace map could not be loaded. Fix the diagnostics below, then Save a valid map.
                    Drafts below stay editable and are not overwritten while dirty.
                  </p>
                  {#if taskTypesSnapshot.diagnostics.length > 0}
                    <ul class="settings-panel__diag-list">
                      {#each taskTypesSnapshot.diagnostics as diag, di (di)}
                        <li data-diag-code={diag.code}>{diag.message}</li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {:else if taskTypesSnapshot.diagnostics.length > 0}
                <div
                  class="settings-panel__notice settings-panel__diagnostics"
                  role="status"
                  data-testid="task-types-diagnostic-ok-with-notes"
                >
                  <ul class="settings-panel__diag-list">
                    {#each taskTypesSnapshot.diagnostics as diag, di (di)}
                      <li data-diag-code={diag.code}>{diag.message}</li>
                    {/each}
                  </ul>
                </div>
              {/if}
            {/if}

            {#if taskTypesError}
              <div class="settings-panel__error" role="alert" data-testid="task-types-save-error">
                <div class="settings-panel__error-title">Task types save failed</div>
                <div>{taskTypesError}</div>
              </div>
            {/if}

            {#if taskTypesSavedMessage}
              <div class="settings-panel__success" role="status" data-testid="task-types-saved">{taskTypesSavedMessage}</div>
            {/if}

            {#if taskTypesDraftError}
              <div class="settings-panel__field-error" role="alert" data-testid="task-types-draft-error">{taskTypesDraftError}</div>
            {/if}

            {#if taskTypesSnapshot}
              <div class="settings-types">
                {#each taskTypeDrafts as row, index (index)}
                  <div class="type-card">
                    <div class="type-card__head">
                      <input
                        id={`tt-id-${index}`}
                        class="settings-panel__input type-card__id"
                        type="text"
                        placeholder="type-id"
                        aria-label="Type id"
                        value={row.id}
                        disabled={taskTypesSaving}
                        oninput={(e) => updateTypeRow(index, { id: (e.currentTarget as HTMLInputElement).value })}
                      />
                      <button
                        type="button"
                        class="settings-panel__icon-btn settings-panel__icon-btn--danger"
                        disabled={taskTypesSaving}
                        aria-label="Remove type"
                        title="Remove type"
                        onclick={() => removeTypeRow(index)}
                      >
                        <span class="codicon codicon-trash" aria-hidden="true"></span>
                      </button>
                    </div>

                    <div class="type-card__grid">
                      <label class="settings-panel__label" for={`tt-backend-${index}`}>Backend</label>
                      <Select
                        id={`tt-backend-${index}`}
                        value={row.backend}
                        disabled={taskTypesSaving}
                        ariaLabel="Backend"
                        options={backendOptions().map((b) => ({ value: b, label: b }))}
                        onchange={(backend) => updateTypeRow(index, { backend, model: undefined })}
                      />

                      <label class="settings-panel__label" for={`tt-model-${index}`}>Model</label>
                      <Select
                        id={`tt-model-${index}`}
                        value={row.model ?? ''}
                        disabled={taskTypesSaving}
                        ariaLabel="Model"
                        placeholder="(agent default)"
                        options={[
                          { value: '', label: '(agent default)' },
                          ...modelOptions(row.backend, row.model).map((opt) => ({
                            value: opt.value,
                            label: opt.name || opt.value,
                          })),
                        ]}
                        onchange={(v) => updateTypeRow(index, { model: v || undefined })}
                      />

                      <label class="settings-panel__label" for={`tt-role-${index}`}>Role</label>
                      <Select
                        id={`tt-role-${index}`}
                        value={row.role}
                        disabled={taskTypesSaving}
                        ariaLabel="Role"
                        options={taskTypesSnapshot.constraints.roles.map((role) => ({ value: role, label: role }))}
                        onchange={(v) => updateTypeRow(index, { role: v as 'coordinator' | 'worker' })}
                      />

                      <label class="settings-panel__label" for={`tt-kind-${index}`}>Brief kind</label>
                      <Select
                        id={`tt-kind-${index}`}
                        value={row.briefKind}
                        disabled={taskTypesSaving}
                        ariaLabel="Brief kind"
                        options={taskTypesSnapshot.constraints.briefKinds.map((kind) => ({ value: kind, label: kind }))}
                        onchange={(v) => updateTypeRow(index, { briefKind: v })}
                      />

                      <label class="settings-panel__label" for={`tt-desc-${index}`}>Description</label>
                      <input
                        id={`tt-desc-${index}`}
                        class="settings-panel__input"
                        type="text"
                        maxlength={taskTypesSnapshot.constraints.descriptionMax}
                        value={row.description ?? ''}
                        disabled={taskTypesSaving}
                        oninput={(e) =>
                          updateTypeRow(index, { description: (e.currentTarget as HTMLInputElement).value || undefined })}
                      />
                    </div>
                  </div>
                {/each}

                {#if taskTypeDrafts.length === 0}
                  <p class="settings-panel__notice">
                    No task types. Add one or Reset to defaults — an empty map blocks create/delegate.
                  </p>
                {/if}
              </div>
            {/if}
          </section>
        {:else if activeTopicId === 'permissions'}
          <section class="settings-section" aria-label="Permissions" data-testid="permissions-settings">
            <div class="settings-section__head">
              <div class="settings-section__heading">
                <h3 class="settings-section__title">Permissions</h3>
                <p class="settings-section__desc">
                  {permissionSettingsSnapshot?.description ??
                    'How Muster handles agent tool-permission requests.'}
                </p>
              </div>
              {#if permissionSettingsSnapshot && permissionDraftMode !== undefined}
                <div class="settings-section__actions">
                  <button
                    type="button"
                    class="settings-panel__btn settings-panel__btn--primary"
                    disabled={permissionSettingsSaving || !permissionDirty}
                    data-testid="permissions-save"
                    aria-label="Save permission mode"
                    onclick={onSavePermissionSettings}
                  >{permissionSettingsSaving ? 'Saving…' : 'Save'}</button>
                </div>
              {/if}
            </div>

            <p
              class="settings-panel__hint settings-panel__scope-copy"
              data-testid="permissions-runtime-note"
              role="note"
            >
              {PERMISSIONS_RUNTIME_NOTE}
            </p>

            {#if permissionSettingsError}
              <div
                class="settings-panel__error"
                role="alert"
                data-testid="permissions-local-error"
                data-topic-error="permissions"
              >
                <div class="settings-panel__error-title">Permission mode save failed</div>
                <div>{permissionSettingsError}</div>
              </div>
            {/if}

            {#if permissionSettingsSavedMessage}
              <div
                class="settings-panel__success"
                role="status"
                data-testid="permissions-local-success"
                data-topic-success="permissions"
              >{permissionSettingsSavedMessage}</div>
            {/if}

            {#if permissionSettingsLoading && !permissionSettingsSnapshot}
              <p class="settings-panel__notice" role="status" data-testid="permissions-loading">
                Loading permission settings from VS Code…
              </p>
            {/if}

            {#if permissionSettingsSnapshot && permissionDraftMode !== undefined}
              {#if permissionDirty}
                <div class="settings-section__status">
                  <span
                    class="settings-section__dirty"
                    data-testid="permissions-dirty"
                    role="status"
                  >Unsaved changes</span>
                </div>
              {/if}

              <div
                class="permission-mode-list"
                role="radiogroup"
                aria-label="Permission mode"
                data-testid="permissions-mode-group"
              >
                {#each permissionSettingsSnapshot.options as option (option.mode)}
                  {@const selected = permissionDraftMode === option.mode}
                  {@const optionId = `permission-mode-${option.mode}`}
                  {@const riskLabel = PERMISSION_MODE_RISK_LABELS[option.risk]}
                  <label
                    class="permission-mode-option"
                    class:permission-mode-option--selected={selected}
                    class:permission-mode-option--least-safe={option.risk === 'least-safe'}
                    class:permission-mode-option--recommended={option.risk === 'recommended'}
                    data-mode={option.mode}
                    data-risk={option.risk}
                    data-testid={`permission-mode-option-${option.mode}`}
                    for={optionId}
                  >
                    <input
                      id={optionId}
                      class="permission-mode-option__input"
                      type="radio"
                      name="permission-mode"
                      value={option.mode}
                      checked={selected}
                      disabled={permissionSettingsSaving}
                      aria-describedby={`${optionId}-desc ${optionId}-risk`}
                      onchange={() => onPermissionDraftModeChange(option.mode)}
                    />
                    <span class="permission-mode-option__body">
                      <span class="permission-mode-option__title-row">
                        <span class="permission-mode-option__label">{option.label}</span>
                        <span
                          id={`${optionId}-risk`}
                          class={`permission-mode-option__risk permission-mode-option__risk--${option.risk}`}
                          data-testid={`permission-mode-risk-${option.mode}`}
                        >{riskLabel}</span>
                      </span>
                      <span
                        id={`${optionId}-desc`}
                        class="permission-mode-option__desc"
                      >{option.description}</span>
                    </span>
                  </label>
                {/each}
              </div>
            {/if}
          </section>
        {:else if activeTopicId === 'retention'}
          <section class="settings-section" aria-label="Runtime and Storage">
            <div class="settings-section__heading">
              <h3 class="settings-section__title">Runtime &amp; Storage</h3>
              <p class="settings-section__desc">
                Control uninterrupted agent runtime and how much completed history is retained.
              </p>
            </div>

            {#if retentionError}
              <div
                class="settings-panel__error"
                role="alert"
                data-testid="retention-local-error"
                data-topic-error="retention"
              >
                <div class="settings-panel__error-title">Runtime &amp; Storage save failed</div>
                <div>{retentionError}</div>
              </div>
            {/if}

            {#if savedMessage}
              <div
                class="settings-panel__success"
                role="status"
                data-testid="retention-local-success"
                data-topic-success="retention"
              >{savedMessage}</div>
            {/if}

            {#if loading && !snapshot}
              <p class="settings-panel__notice" role="status">Loading runtime and storage settings from VS Code…</p>
            {/if}

            {#if snapshot}
              <div class="settings-fields">
                <div class="settings-section__heading">
                  <h4 class="settings-section__title">Agent runtime</h4>
                  <p class="settings-section__desc">Applies to new agent runs; running turns keep their current deadline.</p>
                </div>
                {#each snapshot.settings.filter((candidate) => candidate.id === 'runLimit') as setting (setting.id)}
                  {@const label = displayLabel(setting.id)}
                  {@const error = localFieldErrors[setting.id] ?? fieldErrors[setting.id]}
                  <div class="field-row">
                    <div class="field-row__copy">
                      <label class="settings-panel__label" for={fieldId(setting.id)}>{label}</label>
                      <p class="settings-panel__description">{setting.description}</p>
                      <p class="settings-panel__hint">Default {setting.defaultValue}; waiting for children does not consume this budget.</p>
                      {#if error}
                        <div class="settings-panel__field-error" id={`${fieldId(setting.id)}-error`} role="alert">{error}</div>
                      {/if}
                    </div>
                    <div class="field-row__control">
                      <div class="field-row__input-group">
                        <select
                          id={fieldId(setting.id)}
                          class="settings-panel__input"
                          value={retentionDrafts[setting.id]}
                          aria-invalid={error ? 'true' : 'false'}
                          aria-describedby={error ? `${fieldId(setting.id)}-error` : undefined}
                          disabled={savingSettingId === setting.id}
                          oninput={(event) => onDraftInput(setting.id, event)}
                        >
                          {#each setting.options as option}
                            <option value={option}>{option}</option>
                          {/each}
                        </select>
                        <button
                          type="button"
                          class="settings-panel__btn settings-panel__btn--primary"
                          disabled={savingSettingId === setting.id}
                          aria-label={`Save ${label}`}
                          onclick={() => saveSetting(setting.id)}
                        >Save</button>
                      </div>
                      {#if savingSettingId === setting.id}
                        <div class="settings-panel__saving" role="status">Saving {label}…</div>
                      {/if}
                    </div>
                  </div>
                {/each}
                <details class="settings-section" data-testid="history-storage-advanced">
                  <summary class="settings-section__title">History storage (Advanced)</summary>
                  <p class="settings-section__desc">Limits retained terminal-task history. These values do not stop a running agent.</p>
                  {#each snapshot.settings.filter((candidate) => candidate.kind === 'number') as setting (setting.id)}
                    {@const label = displayLabel(setting.id)}
                    {@const error = localFieldErrors[setting.id] ?? fieldErrors[setting.id]}
                    <div class="field-row">
                      <div class="field-row__copy">
                        <label class="settings-panel__label" for={fieldId(setting.id)}>{label}</label>
                        <p class="settings-panel__description">{setting.description}</p>
                        <p class="settings-panel__hint">Min {setting.minimum} · Default {setting.defaultValue}</p>
                        {#if error}
                          <div class="settings-panel__field-error" id={`${fieldId(setting.id)}-error`} role="alert">{error}</div>
                        {/if}
                      </div>
                      <div class="field-row__control">
                        <div class="field-row__input-group">
                          <input
                            id={fieldId(setting.id)}
                            class="settings-panel__input"
                            type="number"
                            min={setting.minimum}
                            step="1"
                            value={retentionDrafts[setting.id]}
                            aria-invalid={error ? 'true' : 'false'}
                            aria-describedby={error ? `${fieldId(setting.id)}-error` : undefined}
                            disabled={savingSettingId === setting.id}
                            oninput={(event) => onDraftInput(setting.id, event)}
                          />
                          <button
                            type="button"
                            class="settings-panel__btn settings-panel__btn--primary"
                            disabled={savingSettingId === setting.id}
                            aria-label={`Save ${label}`}
                            onclick={() => saveSetting(setting.id, setting.minimum)}
                          >Save</button>
                        </div>
                        {#if savingSettingId === setting.id}
                          <div class="settings-panel__saving" role="status">Saving {label}…</div>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </details>
              </div>
            {/if}
          </section>
        {:else if activeTopic?.availability === 'coming-soon'}
          <section class="settings-section settings-section--coming-soon" aria-label={activeTopic.label}>
            <div class="settings-section__heading">
              <h3 class="settings-section__title">{activeTopic.label}</h3>
              <p class="settings-section__status-line" role="status">Coming soon</p>
              <p class="settings-section__desc">{activeTopic.description}</p>
            </div>
          </section>
        {/if}
      </div>
    </div>
  </div>
</section>
