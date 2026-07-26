<script lang="ts">
  /**
   * Agents → Backends readiness surface (M019/S03).
   *
   * Renders the host BackendReadinessSnapshot through the pure presentation
   * reducer (backend-readiness-view). Probe start/cancel go through the shared
   * tasks store; Refresh posts refreshBackendReadiness. Never enumerates models
   * and never invents readiness from local caches.
   */
  import { tick } from 'svelte';
  import type { BackendReadinessId } from '../../../src/shared/backend-readiness';
  import type { ActiveBackendProbe } from '../lib/backend-eligibility';
  import {
    resolveBackendsSectionState,
    type BackendRowView,
  } from '../lib/backend-readiness-view';
  import { SETTINGS_BACKENDS_FOCUS_ID } from '../lib/settings-backends-deep-link';
  import type { BackendReadinessSnapshot } from '../lib/protocol';
  import { post } from '../lib/protocol';

  interface Props {
    snapshot: BackendReadinessSnapshot | null;
    activeProbe: ActiveBackendProbe | null;
    /** When true, focus the section after mount (Doctor deep-link). */
    focusRequest?: number;
    onStartProbe: (backendId: BackendReadinessId) => void;
    onCancelProbe: () => void;
  }

  let {
    snapshot,
    activeProbe,
    focusRequest = 0,
    onStartProbe,
    onCancelProbe,
  }: Props = $props();

  let sectionEl = $state<HTMLElement | null>(null);

  const section = $derived(resolveBackendsSectionState(snapshot, activeProbe));

  function refreshBackends(): void {
    post({
      type: 'refreshBackendReadiness',
      requestId: `refresh-settings-${Date.now()}`,
    });
  }

  function onTest(row: BackendRowView): void {
    if (!row.canTest) return;
    onStartProbe(row.backendId);
  }

  function onCancel(row: BackendRowView): void {
    if (!row.canCancel) return;
    onCancelProbe();
  }

  // Doctor deep-link: focus the stable settings-backends target when requested.
  $effect(() => {
    if (!focusRequest) return;
    const el = sectionEl;
    if (!el) return;
    void tick().then(() => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      el.focus();
    });
  });
</script>

<section
  bind:this={sectionEl}
  id={SETTINGS_BACKENDS_FOCUS_ID}
  class="settings-section backends-settings"
  data-testid="settings-backends"
  aria-labelledby="settings-backends-title"
  tabindex="-1"
>
  <div class="settings-section__head">
    <div class="settings-section__heading">
      <h3 id="settings-backends-title" class="settings-section__title">Backends</h3>
      <p class="settings-section__desc">
        Installed agent CLIs, readiness, and Test Connection. No secrets or local
        model catalogs are loaded here.
      </p>
    </div>
    <div class="settings-section__actions">
      <button
        type="button"
        class="settings-panel__btn settings-panel__btn--ghost"
        data-testid="backends-refresh"
        aria-label="Refresh backends"
        onclick={refreshBackends}
      >
        <span class="codicon codicon-refresh" aria-hidden="true"></span>
        Refresh
      </button>
    </div>
  </div>

  <p
    class="settings-panel__notice backends-settings__summary"
    role="status"
    data-testid="backends-section-summary"
    data-section-kind={section.kind}
  >
    {section.summaryText}
  </p>

  {#if section.kind === 'loading'}
    <p class="settings-panel__muted" role="status" data-testid="backends-loading">
      Waiting for host inventory…
    </p>
  {:else}
    <ul class="backends-settings__list" role="list" data-testid="backends-list">
      {#each section.rows as row (row.backendId)}
        <li
          class="backend-row"
          class:backend-row--testing={row.isTesting}
          class:backend-row--ready={row.state === 'ready'}
          class:backend-row--diagnostic={row.state === 'auth_required' ||
            row.state === 'failed' ||
            row.state === 'incompatible' ||
            row.state === 'missing'}
          data-testid={`backend-row-${row.backendId}`}
          data-backend-id={row.backendId}
          data-backend-state={row.state}
          aria-label={row.accessibleName}
        >
          <div class="backend-row__main">
            <div class="backend-row__identity">
              <span class="backend-row__label">{row.label}</span>
              <span
                class="backend-row__status"
                data-testid={`backend-row-status-${row.backendId}`}
                data-state={row.state}
              >
                {row.statusLabel}
              </span>
              {#if row.versionEvidence}
                <span
                  class="backend-row__version"
                  data-testid={`backend-row-version-${row.backendId}`}
                >
                  {row.versionEvidence}
                </span>
              {/if}
            </div>

            {#if row.isTesting || row.stageLabel}
              <p
                class="backend-row__progress"
                role="status"
                aria-live="polite"
                data-testid={`backend-row-progress-${row.backendId}`}
              >
                {row.stageLabel || 'Testing…'}
              </p>
            {/if}

            {#if row.diagnosticText}
              <p
                class="backend-row__diagnostic"
                role="status"
                data-testid={`backend-row-diagnostic-${row.backendId}`}
              >
                {row.diagnosticText}
                {#if row.recoveryLabel}
                  <span class="backend-row__recovery"> · {row.recoveryLabel}</span>
                {/if}
              </p>
            {:else if row.recoveryLabel}
              <p
                class="backend-row__diagnostic"
                role="status"
                data-testid={`backend-row-diagnostic-${row.backendId}`}
              >
                {row.recoveryLabel}
              </p>
            {/if}

            {#if row.checkedAtLabel}
              <p class="backend-row__checked" data-testid={`backend-row-checked-${row.backendId}`}>
                Checked {row.checkedAtLabel}
              </p>
            {/if}
          </div>

          <div class="backend-row__actions">
            {#if row.canCancel}
              <button
                type="button"
                class="settings-panel__btn settings-panel__btn--ghost backend-row-cancel"
                data-testid={`backend-row-cancel-${row.backendId}`}
                data-backend-row-cancel={row.backendId}
                aria-label={`Cancel Test Connection for ${row.label}`}
                onclick={() => onCancel(row)}
              >
                Cancel
              </button>
            {/if}
            {#if row.canTest}
              <button
                type="button"
                class="settings-panel__btn settings-panel__btn--primary backend-row-test"
                data-testid={`backend-row-test-${row.backendId}`}
                data-backend-row-test={row.backendId}
                aria-label={`Test Connection for ${row.label}`}
                onclick={() => onTest(row)}
              >
                Test Connection
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
