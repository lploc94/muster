/**
 * Canonical task focus navigation for webview.
 * Posts a single focusTask; defers focusedTaskId until host snapshot (atomic).
 *
 * Draft entry points live here too: task chrome (`tasks`) and transcript
 * (`threadStore`) are separate stores, so opening a draft must reset both.
 * Clearing only `tasks` leaves the previous task's transcript rendered and
 * makes the draft's first message append into that stale thread.
 */

import { post } from './protocol';
import { tasks } from './tasks.svelte';
import { threadStore } from './thread.svelte';

/**
 * Request focus of `taskId`. Does not optimistically set focusedTaskId —
 * `tasks.applySnapshot` applies focus + transcript together when the host replies.
 * Clears draft mode and marks pending hydration for chrome.
 */
export function selectTask(taskId: string): void {
  tasks.beginFocusRequest(taskId);
  post({ type: 'focusTask', taskId });
}

/**
 * Open an unpersisted new-task composer: clear task chrome, drop the focused
 * transcript, and tell the host to release focus.
 */
export function openNewTaskDraft(): void {
  tasks.openNewTaskDraft();
  threadStore.clearFocus();
  post({ type: 'newTask' });
}

/** Same as `openNewTaskDraft`, linked to the terminal task it continues. */
export function openContinuationDraft(terminalTaskId: string): void {
  tasks.openContinuationDraft(terminalTaskId);
  threadStore.clearFocus();
  post({ type: 'newTask' });
}
