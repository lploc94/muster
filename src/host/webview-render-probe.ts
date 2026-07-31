/**
 * Correlates the UAT-only host request with the webview's read-only DOM reply.
 *
 * This module knows no workspace data beyond the observation returned by the
 * webview. The extension supplies the postMessage bridge and owns UAT gating.
 */
export interface RenderProbeFileObservation {
  retentionTruncated: boolean;
  pathText: string;
  countsLabel: string;
  hasStaticSummary: boolean;
  hasDiffBody: boolean;
}

export interface RenderProbeObservation {
  fileChangeGroups: Array<{ fileRowCount: number }>;
  files: RenderProbeFileObservation[];
}

export type RenderProbeReply = {
  type: 'renderProbeResponse';
  requestId: string;
  observation: RenderProbeObservation;
};

type PendingProbe = {
  requestId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (observation: RenderProbeObservation) => void;
  reject: (error: Error) => void;
};

export type WebviewRenderProbeCoordinator = {
  request(): Promise<RenderProbeObservation>;
  accept(message: unknown): boolean;
  dispose(): void;
};

export type WebviewRenderProbeDeps = {
  postMessage(message: { type: 'renderProbeRequest'; requestId: string }): Thenable<boolean>;
  createRequestId(): string;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function isObservation(value: unknown): value is RenderProbeObservation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RenderProbeObservation>;
  return Array.isArray(candidate.fileChangeGroups) && Array.isArray(candidate.files);
}

function isReply(message: unknown): message is RenderProbeReply {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Partial<RenderProbeReply>;
  return candidate.type === 'renderProbeResponse'
    && typeof candidate.requestId === 'string'
    && isObservation(candidate.observation);
}

/** Creates a single-flight coordinator so stale or forged replies cannot satisfy a live UAT request. */
export function createWebviewRenderProbeCoordinator(
  deps: WebviewRenderProbeDeps,
): WebviewRenderProbeCoordinator {
  const setTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((timeout) => clearTimeout(timeout));
  let pending: PendingProbe | undefined;
  let disposed = false;

  function settle(error?: Error, observation?: RenderProbeObservation): void {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimer(current.timeout);
    if (error) current.reject(error);
    else current.resolve(observation!);
  }

  return {
    request(): Promise<RenderProbeObservation> {
      if (disposed) return Promise.reject(new Error('Webview render probe coordinator is disposed'));
      if (pending) return Promise.reject(new Error('Webview render probe request is already pending'));
      const requestId = deps.createRequestId();
      if (!requestId) return Promise.reject(new Error('Webview render probe request id is required'));

      return new Promise<RenderProbeObservation>((resolve, reject) => {
        const timeout = setTimer(
          () => settle(new Error('Webview render probe timed out')),
          deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        pending = { requestId, timeout, resolve, reject };
        Promise.resolve(deps.postMessage({ type: 'renderProbeRequest', requestId })).then(
          (delivered) => {
            if (!delivered && pending?.requestId === requestId) {
              settle(new Error('Webview render probe request could not be delivered'));
            }
          },
          () => {
            if (pending?.requestId === requestId) {
              settle(new Error('Webview render probe request could not be delivered'));
            }
          },
        );
      });
    },
    accept(message: unknown): boolean {
      if (!pending || !isReply(message) || message.requestId !== pending.requestId) return false;
      settle(undefined, message.observation);
      return true;
    },
    dispose(): void {
      disposed = true;
      settle(new Error('Webview render probe coordinator is disposed'));
    },
  };
}
