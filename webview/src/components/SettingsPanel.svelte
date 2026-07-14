<script lang="ts">
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
        <p class="settings-panel__subtitle">Backed by VS Code configuration</p>
      </div>
    </div>
  </div>

  <div class="settings-panel__body">
    {#if globalError}
      <div class="settings-panel__error" role="alert">
        <div class="settings-panel__error-title">Settings save failed</div>
        <div>{globalError}</div>
      </div>
    {/if}

    {#if savedMessage}
      <div class="settings-panel__success" role="status">{savedMessage}</div>
    {/if}

    <!-- Task types -->
    <p class="settings-panel__intro">
      Task types map coordinator create/delegate to backend (and optional model). Stored as
      <code>muster.taskTypes</code> in workspace settings.
    </p>

    {#if taskTypesLoading && !taskTypesSnapshot}
      <p class="settings-panel__notice" role="status">Loading task types…</p>
    {:else if taskTypesSnapshot}
      <p class="settings-panel__notice" role="status">
        Muster ships defaults without model pins. Edit and Save to persist; agents use these presets.
      </p>
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
      <div class="settings-panel__group" aria-label="Task type presets">
        <div class="settings-panel__row">
          <div class="settings-panel__copy">
            <div class="settings-panel__label">Task types</div>
            <div class="settings-panel__description">
              Status: {taskTypesSnapshot.status}. Max {taskTypesSnapshot.constraints.maxTypes} types.
            </div>
          </div>
          <div class="settings-panel__control settings-panel__control--row">
            <button type="button" class="settings-panel__save" disabled={taskTypesSaving} onclick={addTypeRow}>Add type</button>
            <button type="button" class="settings-panel__save" disabled={taskTypesSaving} onclick={resetTypes}>Reset defaults</button>
            <button type="button" class="settings-panel__save" disabled={taskTypesSaving} onclick={saveTypes}>
              {taskTypesSaving ? 'Saving…' : 'Save task types'}
            </button>
          </div>
        </div>

        {#each typeDrafts as row, index (index)}
          <div class="settings-panel__row settings-panel__row--editable settings-panel__row--type">
            <div class="settings-panel__type-grid">
              <label class="settings-panel__label" for={`tt-id-${index}`}>Id</label>
              <input
                id={`tt-id-${index}`}
                class="settings-panel__input"
                type="text"
                value={row.id}
                disabled={taskTypesSaving}
                oninput={(e) => updateTypeRow(index, { id: (e.currentTarget as HTMLInputElement).value })}
              />

              <label class="settings-panel__label" for={`tt-backend-${index}`}>Backend</label>
              <select
                id={`tt-backend-${index}`}
                class="settings-panel__input"
                value={row.backend}
                disabled={taskTypesSaving}
                onchange={(e) => {
                  const backend = (e.currentTarget as HTMLSelectElement).value;
                  updateTypeRow(index, { backend, model: undefined });
                }}
              >
                {#each backendOptions() as b}
                  <option value={b}>{b}</option>
                {/each}
              </select>

              <label class="settings-panel__label" for={`tt-model-${index}`}>Model</label>
              <select
                id={`tt-model-${index}`}
                class="settings-panel__input"
                value={row.model ?? ''}
                disabled={taskTypesSaving}
                onchange={(e) => {
                  const v = (e.currentTarget as HTMLSelectElement).value;
                  updateTypeRow(index, { model: v || undefined });
                }}
              >
                <option value="">(agent default)</option>
                {#each modelOptions(row.backend, row.model) as opt}
                  <option value={opt.value}>{opt.name || opt.value}</option>
                {/each}
              </select>

              <label class="settings-panel__label" for={`tt-role-${index}`}>Role</label>
              <select
                id={`tt-role-${index}`}
                class="settings-panel__input"
                value={row.role}
                disabled={taskTypesSaving}
                onchange={(e) =>
                  updateTypeRow(index, {
                    role: (e.currentTarget as HTMLSelectElement).value as 'coordinator' | 'worker',
                  })}
              >
                {#each taskTypesSnapshot.constraints.roles as role}
                  <option value={role}>{role}</option>
                {/each}
              </select>

              <label class="settings-panel__label" for={`tt-kind-${index}`}>Brief kind</label>
              <select
                id={`tt-kind-${index}`}
                class="settings-panel__input"
                value={row.briefKind}
                disabled={taskTypesSaving}
                onchange={(e) => updateTypeRow(index, { briefKind: (e.currentTarget as HTMLSelectElement).value })}
              >
                {#each taskTypesSnapshot.constraints.briefKinds as kind}
                  <option value={kind}>{kind}</option>
                {/each}
              </select>

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
            <div class="settings-panel__type-actions">
              <button
                type="button"
                class="settings-panel__save"
                disabled={taskTypesSaving}
                onclick={() => removeTypeRow(index)}
              >Remove</button>
            </div>
          </div>
        {/each}

        {#if typeDrafts.length === 0}
          <p class="settings-panel__notice">No types (empty map fails closed for create/delegate). Add types or Reset defaults.</p>
        {/if}
      </div>
    {/if}

    <!-- Retention -->
    <p class="settings-panel__intro">Retention keeps recent task history usable without storing unlimited completed-turn output.</p>

    {#if loading && !snapshot}
      <p class="settings-panel__notice" role="status">Loading retention settings from VS Code…</p>
    {:else if snapshot}
      <p class="settings-panel__notice" role="status">Edit one retention field at a time; each Save writes only that VS Code setting.</p>
    {:else}
      <p class="settings-panel__notice">These values are read from and saved back to VS Code settings.</p>
    {/if}

    {#if snapshot}
      <div class="settings-panel__group" aria-label="Retention settings">
        {#each snapshot.settings as setting (setting.id)}
          {@const label = displayLabel(setting.id)}
          {@const error = localFieldErrors[setting.id] ?? fieldErrors[setting.id]}
          <div class="settings-panel__row settings-panel__row--editable">
            <div class="settings-panel__copy">
              <label class="settings-panel__label" for={fieldId(setting.id)}>{label}</label>
              <div class="settings-panel__description">{setting.description}</div>
              <div class="settings-panel__hint">Minimum {setting.minimum}. Default {setting.defaultValue}.</div>
              {#if error}
                <div class="settings-panel__field-error" id={`${fieldId(setting.id)}-error`} role="alert">{error}</div>
              {/if}
            </div>
            <div class="settings-panel__control">
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
                class="settings-panel__save"
                disabled={savingSettingId === setting.id}
                onclick={() => saveSetting(setting.id, setting.minimum)}
              >Save {label}</button>
              {#if savingSettingId === setting.id}
                <div class="settings-panel__saving" role="status">Saving {label}…</div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
