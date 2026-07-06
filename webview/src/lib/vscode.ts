// Single acquisition of the VS Code webview API. Must be called exactly once
// per webview lifetime, so it lives in this module-level singleton.

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
