import type { NormalizedEvent } from './types';
import type { TaskViewStatus, TranscriptItem } from './protocol';
import { isTerminalStatus } from './protocol';
import type { ThreadItem } from './turn-state.svelte';

function transcriptToThreadItem(item: TranscriptItem): ThreadItem | null {
  switch (item.kind) {
    case 'user': {
      const text =
        typeof item.content === 'string'
          ? item.content
          : ((item.content as { text?: string })?.text ?? '');
      return { kind: 'user', id: item.id, text };
    }
    case 'assistant': {
      const text =
        typeof item.content === 'string'
          ? item.content
          : ((item.content as { text?: string })?.text ?? '');
      return { kind: 'assistant', id: item.id, text };
    }
    case 'error': {
      const content = item.content as { message?: string; isCancellation?: boolean } | string;
      const message = typeof content === 'string' ? content : (content?.message ?? 'Error');
      const isCancellation = typeof content === 'object' ? content?.isCancellation : false;
      return { kind: 'error', id: item.id, message, isCancellation };
    }
    case 'tool': {
      // support persisted tool items if ever sent in transcript
      const t = item.content as any;
      return {
        kind: 'tool',
        id: item.id,
        name: t?.name ?? 'tool',
        toolKind: t?.toolKind,
        status: t?.status ?? 'success',
        input: t?.input,
        output: t?.output,
        error: t?.error,
      };
    }
    default:
      return null;
  }
}

/** Per-task streaming thread (docs/WEBVIEW.md §7.3). */
export class TaskThread {
  items = $state<ThreadItem[]>([]);
  streaming = $state<{ messageId: string; text: string } | null>(null);
  running = $state(false);
  activeTurnId = $state<string | null>(null);
  readOnly = $state(false);

  hydrate(transcript: TranscriptItem[], activeTurnId?: string, viewStatus?: TaskViewStatus): void {
    const next: ThreadItem[] = [];
    for (const item of transcript) {
      const mapped = transcriptToThreadItem(item);
      if (mapped) next.push(mapped);
    }
    // Preserve tool call history (they are added via events during turns and not in base transcript)
    const toolItems = this.items.filter((it): it is Extract<ThreadItem, { kind: 'tool' }> => it.kind === 'tool');
    // avoid dups by id
    const existingIds = new Set(next.map((i) => i.id));
    const additionalTools = toolItems.filter((t) => !existingIds.has(t.id));

    // Insert tools before the last assistant message so that:
    // user -> tools -> final assistant  (tools belong to the same turn as the message)
    let insertPos = next.length;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].kind === 'assistant') {
        insertPos = i;
        break;
      }
    }
    this.items = [
      ...next.slice(0, insertPos),
      ...additionalTools,
      ...next.slice(insertPos),
    ];
    this.streaming = null;
    this.activeTurnId = activeTurnId ?? null;
    this.running = viewStatus === 'running' || viewStatus === 'waiting_user';
    this.readOnly = viewStatus ? isTerminalStatus(viewStatus) : false;
  }

  reset(): void {
    this.items = [];
    this.streaming = null;
    this.running = false;
    this.activeTurnId = null;
    this.readOnly = false;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  appendTranscript(item: TranscriptItem): void {
    const mapped = transcriptToThreadItem(item);
    if (mapped) this.items.push(mapped);
  }

  startTurn(turnId: string): void {
    this.running = true;
    this.activeTurnId = turnId;
  }

  endTurn(): void {
    this.commitStreaming();
    this.running = false;
    this.activeTurnId = null;
  }

  pushError(message: string, isCancellation = false): void {
    this.commitStreaming();
    this.items.push({ kind: 'error', id: `err-${Date.now()}`, message, isCancellation });
  }

  private commitStreaming(): void {
    if (this.streaming && this.streaming.text.length > 0) {
      this.items.push({
        kind: 'assistant',
        id: `asst-${this.streaming.messageId}`,
        text: this.streaming.text,
      });
    }
    this.streaming = null;
  }

  private findTool(id: string): Extract<ThreadItem, { kind: 'tool' }> | undefined {
    for (const it of this.items) {
      if (it.kind === 'tool' && it.id === id) return it;
    }
    return undefined;
  }

  /** Reduce one NormalizedEvent into the thread (docs/WEBVIEW.md §5). */
  applyEvent(ev: NormalizedEvent): void {
    switch (ev.type) {
      case 'assistantDelta':
        if (!this.streaming || this.streaming.messageId !== ev.messageId) {
          this.commitStreaming();
          this.streaming = { messageId: ev.messageId, text: '' };
        }
        this.streaming.text += ev.content;
        break;

      case 'toolStarted':
        this.commitStreaming();
        this.items.push({
          kind: 'tool',
          id: ev.toolCallId,
          name: ev.name,
          toolKind: ev.kind,
          status: 'running',
          input: ev.input,
        });
        break;

      case 'toolCompleted': {
        const tool = this.findTool(ev.toolCallId);
        if (tool) {
          tool.status = ev.outcome;
          if (ev.outcome === 'error') {
            tool.error = ev.error;
          } else {
            tool.output = ev.output;
          }
        }
        break;
      }

      case 'error':
        this.pushError(ev.message, ev.isCancellation ?? false);
        break;

      case 'turnCompleted':
        this.commitStreaming();
        break;

      case 'sessionStarted':
      case 'reasoningDelta':
      case 'toolUpdated': {
        const t = this.findTool(ev.toolCallId);
        if (t && ev.input !== undefined) {
          t.input = ev.input;
        }
        break;
      }
      case 'usage':
      case 'raw':
        break;
    }
  }
}

class ThreadStore {
  private byTask = new Map<string, TaskThread>();
  current = $state<TaskThread>(new TaskThread());
  currentTaskId = $state<string | null>(null);

  private getOrCreate(taskId: string): TaskThread {
    let thread = this.byTask.get(taskId);
    if (!thread) {
      thread = new TaskThread();
      this.byTask.set(taskId, thread);
    }
    return thread;
  }

  focusTask(
    taskId: string,
    transcript?: TranscriptItem[],
    activeTurnId?: string,
    viewStatus?: TaskViewStatus,
  ): void {
    const thread = this.getOrCreate(taskId);
    this.current = thread;
    this.currentTaskId = taskId;
    if (transcript) {
      thread.hydrate(transcript, activeTurnId, viewStatus);
    } else if (viewStatus) {
      thread.setReadOnly(isTerminalStatus(viewStatus));
    }
  }

  clearFocus(): void {
    this.current = new TaskThread();
    this.currentTaskId = null;
  }

  onTurnStart(taskId: string, turnId: string): void {
    if (taskId !== this.currentTaskId) return;
    this.current.startTurn(turnId);
  }

  onEvent(taskId: string, turnId: string, event: NormalizedEvent): void {
    if (taskId !== this.currentTaskId) return;
    if (turnId !== this.current.activeTurnId) return;
    this.current.applyEvent(event);
  }

  onTurnDone(taskId: string, turnId: string): void {
    if (taskId !== this.currentTaskId) return;
    if (turnId !== this.current.activeTurnId) return;
    this.current.endTurn();
  }

  onTurnError(taskId: string, turnId: string, message: string): void {
    if (taskId !== this.currentTaskId) return;
    if (turnId !== this.current.activeTurnId) return;
    this.current.pushError(message);
    this.current.endTurn();
  }

  onTranscriptAppend(taskId: string, item: TranscriptItem): void {
    if (taskId !== this.currentTaskId) return;
    this.current.appendTranscript(item);
  }

  updateReadOnly(viewStatus: TaskViewStatus): void {
    this.current.setReadOnly(isTerminalStatus(viewStatus));
  }
}

export const threadStore = new ThreadStore();