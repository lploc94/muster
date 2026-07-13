import { randomUUID } from 'crypto';
import type {
  ElicitationAction,
  ParsedFormElicitation,
  ParsedUrlElicitation,
  ParsedUrlRequiredEntry,
} from '../backends/elicitation';

export type ElicitationResolve = {
  action: ElicitationAction;
  content?: Record<string, unknown>;
};

export type PendingFormPrompt = ParsedFormElicitation & {
  promptId: string;
  clientKey: string;
  askLike: boolean;
};

export type PendingUrlConsent = {
  kind: 'url';
  promptId: string;
  clientKey: string;
  elicitationId: string;
  url: string;
  message: string;
  sessionId?: string;
  requestId?: string | number;
  parentRequestId?: string;
};

export type OobUrlEntry = {
  promptId: string;
  clientKey: string;
  elicitationId: string;
  url: string;
  message: string;
  parentRequestId?: string;
};

type PendingEntry =
  | {
      kind: 'form';
      prompt: PendingFormPrompt;
      resolve: (r: ElicitationResolve) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  | {
      kind: 'url';
      prompt: PendingUrlConsent;
      resolve: (r: ElicitationResolve) => void;
      timer?: ReturnType<typeof setTimeout>;
    };

function oobKey(clientKey: string, elicitationId: string): string {
  return `${clientKey}:${elicitationId}`;
}

/**
 * Bridges ACP elicitation prompts to the webview.
 * Owns consent pending map + post-accept OOB URL map.
 */
export class ElicitationBridge {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly oob = new Map<string, OobUrlEntry>();
  private readonly onRegister?: (
    kind: 'form' | 'url',
    prompt: PendingFormPrompt | PendingUrlConsent,
  ) => void;
  private readonly onWaiting?: (entry: OobUrlEntry) => void;
  private readonly onClear?: (promptId: string) => void;

  constructor(options?: {
    onRegister?: (kind: 'form' | 'url', prompt: PendingFormPrompt | PendingUrlConsent) => void;
    onWaiting?: (entry: OobUrlEntry) => void;
    onClear?: (promptId: string) => void;
  }) {
    this.onRegister = options?.onRegister;
    this.onWaiting = options?.onWaiting;
    this.onClear = options?.onClear;
  }

  generatePromptId(): string {
    return randomUUID();
  }

  listPending(): Array<PendingFormPrompt | PendingUrlConsent> {
    return [...this.pending.values()].map((e) => e.prompt);
  }

  listOob(): OobUrlEntry[] {
    return [...this.oob.values()];
  }

  peekForm(promptId: string): PendingFormPrompt | undefined {
    const entry = this.pending.get(promptId);
    if (entry?.kind === 'form') return entry.prompt;
    return undefined;
  }

  peekUrl(promptId: string): PendingUrlConsent | undefined {
    const entry = this.pending.get(promptId);
    if (entry?.kind === 'url') return entry.prompt;
    return undefined;
  }

  /** Cancel pending prompts for a session without soft side-effects beyond resolve. */
  cancelForSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      const sid =
        entry.kind === 'form' ? entry.prompt.sessionId : entry.prompt.sessionId;
      if (sid === sessionId) {
        this.finish(id, { action: 'cancel' });
      }
    }
  }

  registerForm(
    clientKey: string,
    form: ParsedFormElicitation,
    askLike: boolean,
    deadlineMs: number,
  ): { promptId: string; promise: Promise<ElicitationResolve> } {
    const promptId = this.generatePromptId();
    const prompt: PendingFormPrompt = { ...form, promptId, clientKey, askLike };
    let resolve!: (r: ElicitationResolve) => void;
    const promise = new Promise<ElicitationResolve>((res) => {
      resolve = res;
    });
    const entry: PendingEntry = { kind: 'form', prompt, resolve };
    this.pending.set(promptId, entry);
    this.onRegister?.('form', prompt);
    if (deadlineMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.pending.get(promptId) === entry) {
          this.finish(promptId, { action: 'cancel' });
        }
      }, deadlineMs);
    }
    return { promptId, promise };
  }

  registerUrl(
    clientKey: string,
    urlReq: ParsedUrlElicitation | ParsedUrlRequiredEntry,
    deadlineMs: number,
    extra?: { sessionId?: string; requestId?: string | number; parentRequestId?: string },
  ): { promptId: string; promise: Promise<ElicitationResolve> } {
    const promptId = this.generatePromptId();
    const elicitationId =
      urlReq.kind === 'url' ? urlReq.elicitationId : urlReq.elicitationId;
    const prompt: PendingUrlConsent = {
      kind: 'url',
      promptId,
      clientKey,
      elicitationId,
      url: urlReq.url,
      message: urlReq.message,
      sessionId: urlReq.kind === 'url' ? urlReq.sessionId : extra?.sessionId,
      requestId: urlReq.kind === 'url' ? urlReq.requestId : extra?.requestId,
      parentRequestId: extra?.parentRequestId,
    };
    let resolve!: (r: ElicitationResolve) => void;
    const promise = new Promise<ElicitationResolve>((res) => {
      resolve = res;
    });
    const entry: PendingEntry = { kind: 'url', prompt, resolve };
    this.pending.set(promptId, entry);
    this.onRegister?.('url', prompt);
    if (deadlineMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.pending.get(promptId) === entry) {
          this.finish(promptId, { action: 'cancel' });
        }
      }, deadlineMs);
    }
    return { promptId, promise };
  }

  submit(promptId: string, resolve: ElicitationResolve): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    if (entry.kind === 'url' && resolve.action === 'accept') {
      // Consent accepted → move to OOB; still resolve create promise with accept
      const oob: OobUrlEntry = {
        promptId: entry.prompt.promptId,
        clientKey: entry.prompt.clientKey,
        elicitationId: entry.prompt.elicitationId,
        url: entry.prompt.url,
        message: entry.prompt.message,
        parentRequestId: entry.prompt.parentRequestId,
      };
      this.clearPending(promptId);
      this.oob.set(oobKey(oob.clientKey, oob.elicitationId), oob);
      entry.resolve({ action: 'accept' });
      this.onWaiting?.(oob);
      return true;
    }
    return this.finish(promptId, resolve);
  }

  complete(clientKey: string, elicitationId: string): boolean {
    const key = oobKey(clientKey, elicitationId);
    const entry = this.oob.get(key);
    if (!entry) return false;
    this.oob.delete(key);
    this.onClear?.(entry.promptId);
    return true;
  }

  cancelAll(): void {
    for (const [id] of this.pending) {
      this.finish(id, { action: 'cancel' });
    }
    for (const entry of this.oob.values()) {
      this.onClear?.(entry.promptId);
    }
    this.oob.clear();
  }

  private finish(promptId: string, resolve: ElicitationResolve): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    this.clearPending(promptId);
    entry.resolve(resolve);
    this.onClear?.(promptId);
    return true;
  }

  private clearPending(promptId: string): void {
    const entry = this.pending.get(promptId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(promptId);
  }
}
