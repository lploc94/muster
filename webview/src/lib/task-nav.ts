/**
 * Canonical task focus navigation for webview.
 * Posts a single focusTask; defers focusedTaskId until host snapshot (atomic).
 */

import { post } from './protocol';
import { tasks } from './tasks.svelte';

/**
 * Request focus of `taskId`. Does not optimistically set focusedTaskId —
 * `tasks.applySnapshot` applies focus + transcript together when the host replies.
 * Clears draft mode and marks pending hydration for chrome.
 */
export function selectTask(taskId: string): void {
  tasks.beginFocusRequest(taskId);
  post({ type: 'focusTask', taskId });
}
