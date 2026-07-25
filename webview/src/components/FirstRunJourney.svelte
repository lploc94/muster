<script lang="ts">
  /**
   * Derived first-run journey empty-state surface (M019/S03 T04).
   *
   * Pure presentation over resolveFirstRunJourney — no durable onboarding flag.
   * Visible only when taskCount is 0 and the host snapshot is settled with a
   * remaining setup step (install → refresh → test → first task).
   */
  import type { BackendReadinessSnapshot } from '../lib/protocol';
  import { post } from '../lib/protocol';
  import {
    resolveFirstRunJourney,
    type FirstRunStep,
    type FirstRunStepId,
  } from '../lib/backend-readiness-view';
  import { resolveOpenBackendSetupAction } from '../lib/composer-backend-setup';

  interface Props {
    snapshot: BackendReadinessSnapshot | null;
    taskCount: number;
    onOpenBackendSetup: () => void;
    onStartFirstTask: () => void;
  }

  let {
    snapshot,
    taskCount,
    onOpenBackendSetup,
    onStartFirstTask,
  }: Props = $props();

  const journey = $derived(
    resolveFirstRunJourney({
      snapshot,
      taskCount,
    }),
  );

  function refreshBackends(): void {
    post({
      type: 'refreshBackendReadiness',
      requestId: `first-run-refresh-${Date.now()}`,
    });
  }

  function primaryAction(): void {
    const step = journey.activeStepId;
    if (step === 'install' || step === 'test') {
      onOpenBackendSetup();
      return;
    }
    if (step === 'refresh') {
      refreshBackends();
      return;
    }
    if (step === 'first-task') {
      onStartFirstTask();
    }
  }

  function primaryLabel(stepId: FirstRunStepId): string {
    switch (stepId) {
      case 'install':
        return 'Open backend setup';
      case 'refresh':
        return 'Refresh backends';
      case 'test':
        return 'Open backend setup';
      case 'first-task':
        return 'Start first task';
      default:
        return 'Continue';
    }
  }

  function stepStateLabel(step: FirstRunStep): string {
    switch (step.state) {
      case 'done':
        return 'Done';
      case 'active':
        return 'Current';
      default:
        return 'Upcoming';
    }
  }
</script>

{#if journey.visible}
  <section
    class="first-run-journey"
    data-testid="first-run-journey"
    data-active-step={journey.activeStepId}
    aria-labelledby="first-run-journey-title"
  >
    <div class="first-run-journey__head">
      <h2 id="first-run-journey-title" class="first-run-journey__title">
        {journey.headline}
      </h2>
      <p class="first-run-journey__detail" role="status" data-testid="first-run-journey-detail">
        {journey.detail}
      </p>
    </div>

    <ol class="first-run-journey__steps" data-testid="first-run-journey-steps">
      {#each journey.steps as step (step.id)}
        <li
          class="first-run-journey__step"
          class:first-run-journey__step--done={step.state === 'done'}
          class:first-run-journey__step--active={step.state === 'active'}
          class:first-run-journey__step--todo={step.state === 'todo'}
          data-step-id={step.id}
          data-step-state={step.state}
          data-testid={`first-run-step-${step.id}`}
          aria-current={step.state === 'active' ? 'step' : undefined}
        >
          <span class="first-run-journey__step-marker" aria-hidden="true">
            {#if step.state === 'done'}
              <span class="codicon codicon-check"></span>
            {:else if step.state === 'active'}
              <span class="codicon codicon-circle-filled"></span>
            {:else}
              <span class="codicon codicon-circle-outline"></span>
            {/if}
          </span>
          <span class="first-run-journey__step-body">
            <span class="first-run-journey__step-label">{step.label}</span>
            <span class="first-run-journey__step-state">{stepStateLabel(step)}</span>
          </span>
        </li>
      {/each}
    </ol>

    <div class="first-run-journey__actions">
      <button
        type="button"
        class="first-run-journey__primary"
        data-testid="first-run-journey-primary"
        aria-label={primaryLabel(journey.activeStepId)}
        onclick={primaryAction}
      >
        {primaryLabel(journey.activeStepId)}
      </button>
      {#if journey.activeStepId === 'install' || journey.activeStepId === 'test'}
        <button
          type="button"
          class="first-run-journey__secondary"
          data-testid="first-run-journey-refresh"
          aria-label="Refresh backends"
          onclick={refreshBackends}
        >
          Refresh backends
        </button>
      {/if}
      {#if journey.activeStepId === 'first-task'}
        <button
          type="button"
          class="first-run-journey__secondary"
          data-testid="first-run-journey-open-setup"
          aria-label="Open backend setup"
          onclick={() => {
            const action = resolveOpenBackendSetupAction();
            void action;
            onOpenBackendSetup();
          }}
        >
          Open backend setup
        </button>
      {/if}
    </div>
  </section>
{/if}
