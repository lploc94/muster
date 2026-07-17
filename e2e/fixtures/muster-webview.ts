import { expect, type Page } from '@playwright/test';

export interface MusterHostInstallOptions {
  /** Seed returned by `getState()` until `setState` replaces it. */
  initialState?: unknown;
  /**
   * When true (default for main webview), postMessage payloads are
   * structuredClone'd to match the VS Code webview boundary.
   * Presentation behavioral suites keep the legacy non-clone path.
   */
  structuredCloneMessages?: boolean;
  /**
   * Window bag used for getState/setState.
   * - main webview: `__musterVsCodeState` (object bag with `.value`)
   * - presentation: `__musterPersistedState` (direct value)
   */
  stateMode?: 'bag' | 'direct';
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage(message: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };
    __musterPostedMessages?: unknown[];
    __musterVsCodeState?: { value: unknown };
    __musterPersistedState?: unknown;
  }
}

/**
 * Install a typed VS Code webview API mock via addInitScript.
 * Preserves structured-clone postMessage semantics when requested.
 */
export async function installMusterVsCodeApi(
  page: Page,
  options: MusterHostInstallOptions = {},
): Promise<void> {
  const structuredCloneMessages = options.structuredCloneMessages ?? true;
  const stateMode = options.stateMode ?? 'bag';

  await page.addInitScript(
    ({ seed, cloneMessages, mode }) => {
      if (mode === 'bag') {
        const bag = { value: seed as unknown };
        window.__musterVsCodeState = bag;
      } else {
        window.__musterPersistedState = seed;
      }

      window.acquireVsCodeApi = () => ({
        postMessage(message: unknown) {
          const payload = cloneMessages ? structuredClone(message) : message;
          window.__musterPostedMessages = [...(window.__musterPostedMessages ?? []), payload];
          window.dispatchEvent(new CustomEvent('muster:test:postMessage', { detail: payload }));
        },
        getState() {
          if (mode === 'bag') {
            return window.__musterVsCodeState?.value;
          }
          return window.__musterPersistedState;
        },
        setState(nextState: unknown) {
          if (mode === 'bag') {
            if (!window.__musterVsCodeState) {
              window.__musterVsCodeState = { value: nextState };
            } else {
              window.__musterVsCodeState.value = nextState;
            }
            return;
          }
          window.__musterPersistedState = nextState;
        },
      });
    },
    {
      seed: options.initialState ?? undefined,
      cloneMessages: structuredCloneMessages,
      mode: stateMode,
    },
  );
}

export async function openMusterWebview(
  page: Page,
  options: MusterHostInstallOptions & { waitForReady?: boolean } = {},
): Promise<void> {
  await installMusterVsCodeApi(page, {
    initialState: options.initialState,
    structuredCloneMessages: options.structuredCloneMessages ?? true,
    stateMode: 'bag',
  });

  await page.goto('/');
  await page.evaluate(() => {
    window.__musterPostedMessages = [];
  });

  if (options.waitForReady !== false) {
    await expect(page.getByText('New task')).toBeVisible();
  }
}

export async function openMusterPresentation(
  page: Page,
  options: MusterHostInstallOptions & { waitForReady?: boolean } = {},
): Promise<void> {
  // Preserve existing Presentation behavioral helper semantics: no structured clone by default.
  await installMusterVsCodeApi(page, {
    initialState: options.initialState,
    structuredCloneMessages: options.structuredCloneMessages ?? false,
    stateMode: 'direct',
  });

  await page.goto('/presentation.html');
  if (options.waitForReady === true) {
    await expect(page.locator('#app')).toBeVisible();
  }
}

export async function readMusterWebviewState(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__musterVsCodeState?.value);
}

export async function readMusterPresentationState(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__musterPersistedState);
}
