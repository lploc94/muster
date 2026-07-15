<script lang="ts">
  import Select from './Select.svelte';
  import type {
    RetentionSettingId,
    RetentionSettingSnapshot,
    TaskTypeSettingsRow,
    TaskTypesSettingsSnapshot,
  } from '../lib/protocol';

  interface Props {
    onClose: () => void;
    snapshot: RetentionSettingSnapshot | null;
    loading: boolean;
    savingSettingId: RetentionSettingId | null;
    savedMessage: string | null;
    globalError: string | null;
    fieldErrors: Partial<Record<RetentionSettingId, string>>;
    onSave: (settingId: RetentionSettingId, value: number) => void;
    /** Task types (muster.taskTypes) */
    taskTypesSnapshot: TaskTypesSettingsSnapshot | null;
    taskTypesLoading: boolean;
    taskTypesSaving: boolean;
    taskTypesSavedMessage: string | null;
    taskTypesError: string | null;
    availableBackends: string[];
    modelsByBackend: Record<string, { current?: string; options: { value: string; name: string }[] }>;
    onSaveTaskTypes: (types: TaskTypeSettingsRow[]) => void;
    onResetTaskTypes: () => void;
  }

  const LABELS: Record<RetentionSettingId, string> = {
    maxTurnsPerTask: 'Maximum turns per task',
    maxStoredOutputChars: 'Maximum stored output characters',
  };

  const TASK_TYPE_STATUS_LABEL: Record<TaskTypesSettingsSnapshot['status'], string> = {
    ok: 'Valid',
    empty: 'Empty',
    invalid: 'Invalid',
  };

  let {
    onClose,
    snapshot,
    loading,
    savingSettingId,
    savedMessage,
    globalError,
    fieldErrors,
    onSave,
    taskTypesSnapshot,
    taskTypesLoading,
    taskTypesSaving,
    taskTypesSavedMessage,
    taskTypesError,
    availableBackends,
    modelsByBackend,
    onSaveTaskTypes,
    onResetTaskTypes,
  }: Props = $props();

  let drafts = $state<Record<RetentionSettingId, string>>({
    maxTurnsPerTask: '',
    maxStoredOutputChars: '',
  });
  let localFieldErrors = $state<Partial<Record<RetentionSettingId, string>>>({});
  let hydratedSignature = $state('');

  let typeDrafts = $state<TaskTypeSettingsRow[]>([]);
  let typeDraftError = $state<string | null>(null);
  let typesHydratedSig = $state('');

  function hydrateDraftsFromSnapshot() {
    if (!snapshot) return;
    drafts = snapshot.settings.reduce(
      (next, setting) => ({ ...next, [setting.id]: String(setting.value) }),
      {} as Record<RetentionSettingId, string>,
    );
    hydratedSignature = snapshot.settings.map((setting) => `${setting.id}:${setting.value}`).join('|');
  }

  function hydrateTypeDrafts() {
    if (!taskTypesSnapshot) return;
    typeDrafts = taskTypesSnapshot.types.map((t) => ({ ...t }));
    typesHydratedSig = JSON.stringify(taskTypesSnapshot.types);
    typeDraftError = null;
  }

  $effect(() => {
    const signature = snapshot ? snapshot.settings.map((setting) => `${setting.id}:${setting.value}`).join('|') : '';
    if (!signature || signature === hydratedSignature) return;
    hydrateDraftsFromSnapshot();
  });

  $effect(() => {
    if (!globalError || !snapshot) return;
    hydrateDraftsFromSnapshot();
  });

  $effect(() => {
    if (!taskTypesSnapshot) return;
    const sig = JSON.stringify(taskTypesSnapshot.types);
    if (sig === typesHydratedSig) return;
    hydrateTypeDrafts();
  });

  $effect(() => {
    if (!taskTypesError || !taskTypesSnapshot) return;
    hydrateTypeDrafts();
  });

  function displayLabel(settingId: RetentionSettingId): string {
    return LABELS[settingId];
  }

  function fieldId(settingId: RetentionSettingId): string {
    return `settings-${settingId}`;
  }

  function updateDraft(settingId: RetentionSettingId, value: string) {
    drafts = { ...drafts, [settingId]: value };
    localFieldErrors = { ...localFieldErrors, [settingId]: undefined };
  }

  function onDraftInput(settingId: RetentionSettingId, event: Event) {
    updateDraft(settingId, (event.currentTarget as HTMLInputElement).value);
  }

  function validationMessage(settingId: RetentionSettingId, minimum: number): string | null {
    const label = displayLabel(settingId);
    const raw = drafts[settingId]?.trim() ?? '';
    const value = Number(raw);

    if (!raw || !Number.isFinite(value)) return `${label} must be a number.`;
    if (!Number.isInteger(value)) return `${label} must be an integer.`;
    if (value < minimum) return `${label} must be at least ${minimum}.`;
    return null;
  }

  function saveSetting(settingId: RetentionSettingId, minimum: number) {
    const message = validationMessage(settingId, minimum);
    if (message) {
      localFieldErrors = { ...localFieldErrors, [settingId]: message };
      return;
    }

    localFieldErrors = { ...localFieldErrors, [settingId]: undefined };
    onSave(settingId, Number(drafts[settingId]));
  }

  function backendOptions(): string[] {
    const fromCatalog = availableBackends.length > 0 ? availableBackends : [];
    const fromDrafts = typeDrafts.map((t) => t.backend).filter(Boolean);
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
    typeDrafts = typeDrafts.map((row, i) => (i === index ? { ...row, ...patch } : row));
    typeDraftError = null;
  }

  function removeTypeRow(index: number) {
    typeDrafts = typeDrafts.filter((_, i) => i !== index);
    typeDraftError = null;
  }

  function addTypeRow() {
    const max = taskTypesSnapshot?.constraints.maxTypes ?? 32;
    if (typeDrafts.length >= max) {
      typeDraftError = `At most ${max} task types.`;
      return;
    }
    typeDrafts = [
      ...typeDrafts,
      {
        id: '',
        backend: availableBackends[0] ?? 'opencode',
        role: 'worker',
        briefKind: 'generic',
      },
    ];
    typeDraftError = null;
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
    for (const row of typeDrafts) {
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
      typeDraftError = err;
      return;
    }
    typeDraftError = null;
    onSaveTaskTypes(
      typeDrafts.map((row) => {
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
    typeDrafts = taskTypesSnapshot.defaults.map((t) => ({ ...t }));
    typeDraftError = null;
    onResetTaskTypes();
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

  <div class="settings-panel__body">
    <div class="settings-panel__body-inner">
    {#if globalError}
      <div class="settings-panel__error" role="alert">
        <div class="settings-panel__error-title">Settings save failed</div>
        <div>{globalError}</div>
      </div>
    {/if}

    {#if savedMessage}
      <div class="settings-panel__success" role="status">{savedMessage}</div>
    {/if}

    <!-- ===== Task Types ===== -->
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

      {#if taskTypesLoading && !taskTypesSnapshot}
        <p class="settings-panel__notice" role="status">Loading task types…</p>
      {:else if taskTypesSnapshot}
        <div class="settings-section__status">
          <span class={`type-status type-status--${taskTypesSnapshot.status}`}>
            <span class="type-status__dot" aria-hidden="true"></span>
            {TASK_TYPE_STATUS_LABEL[taskTypesSnapshot.status]}
          </span>
          <span class="settings-section__count">
            {typeDrafts.length} of {taskTypesSnapshot.constraints.maxTypes} types
          </span>
        </div>
      {/if}

      {#if taskTypesError}
        <div class="settings-panel__error" role="alert">
          <div class="settings-panel__error-title">Task types save failed</div>
          <div>{taskTypesError}</div>
        </div>
      {/if}

      {#if taskTypesSavedMessage}
        <div class="settings-panel__success" role="status">{taskTypesSavedMessage}</div>
      {/if}

      {#if typeDraftError}
        <div class="settings-panel__field-error" role="alert">{typeDraftError}</div>
      {/if}

      {#if taskTypesSnapshot}
        <div class="settings-types">
          {#each typeDrafts as row, index (index)}
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

          {#if typeDrafts.length === 0}
            <p class="settings-panel__notice">
              No task types. Add one or Reset to defaults — an empty map blocks create/delegate.
            </p>
          {/if}
        </div>
      {/if}
    </section>

    <!-- ===== Retention ===== -->
    <section class="settings-section" aria-label="Retention">
      <div class="settings-section__heading">
        <h3 class="settings-section__title">Retention</h3>
        <p class="settings-section__desc">
          Retention keeps recent task history usable without storing unlimited completed-turn output.
        </p>
      </div>

      {#if loading && !snapshot}
        <p class="settings-panel__notice" role="status">Loading retention settings from VS Code…</p>
      {/if}

      {#if snapshot}
        <div class="settings-fields">
          {#each snapshot.settings as setting (setting.id)}
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
                    value={drafts[setting.id]}
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
        </div>
      {/if}
    </section>
    </div>
  </div>
</section>
