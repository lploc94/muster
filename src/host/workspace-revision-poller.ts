/**
 * Visible/focus workspace revision poller (P4-W10).
 *
 * data_version is a cheap optimization only; workspace revision is the source of
 * truth. Timers are injectable so unit tests never sleep for real intervals.
 */

export const WORKSPACE_POLL_ACTIVE_MS = 250;
export const WORKSPACE_POLL_MAX_MS = 5_000;
export const WORKSPACE_POLL_IDLE_FACTOR = 2;

export type WorkspaceRevisionPollerOptions = {
  /** Cheap SQLite data_version via named repository API. */
  getStorageDataVersion: () => Promise<number>;
  /** Workspace revision source of truth. */
  getWorkspaceRevision: () => Promise<number>;
  /**
   * Apply external revisions after `afterRevision` up to `currentRevision`.
   * Must not advance the applied cursor on failure.
   */
  onExternalRevisions: (args: {
    afterRevision: number;
    currentRevision: number;
  }) => Promise<void>;
  /** Gap / invariant / unrecoverable poll failure. */
  onRecovery: (reason: 'gap' | 'invariant' | 'error') => void | Promise<void>;
  /** Whether polling is allowed (view visible + window focused + not disposed). */
  isActive: () => boolean;
  /** Last revision this host has already published or recovered to. */
  getAppliedRevision: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
  activeIntervalMs?: number;
  maxIntervalMs?: number;
  idleFactor?: number;
};

/**
 * Adaptive revision poller. One in-flight poll; concurrent triggers coalesce.
 * Errors back off without advancing the applied cursor.
 */
export class WorkspaceRevisionPoller {
  private readonly getStorageDataVersion: WorkspaceRevisionPollerOptions['getStorageDataVersion'];
  private readonly getWorkspaceRevision: WorkspaceRevisionPollerOptions['getWorkspaceRevision'];
  private readonly onExternalRevisions: WorkspaceRevisionPollerOptions['onExternalRevisions'];
  private readonly onRecovery: WorkspaceRevisionPollerOptions['onRecovery'];
  private readonly isActive: WorkspaceRevisionPollerOptions['isActive'];
  private readonly getAppliedRevision: WorkspaceRevisionPollerOptions['getAppliedRevision'];
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly clearSchedule: (handle: unknown) => void;
  private readonly activeIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly idleFactor: number;

  private timer: unknown | null = null;
  private running = false;
  private disposed = false;
  private pollInFlight = false;
  private pendingImmediate = false;
  private intervalMs: number;
  private lastDataVersion: number | undefined;
  /** Highest workspace revision observed; used to re-poll after failed recovery. */
  private observedRevision: number | undefined;
  private pollCount = 0;

  constructor(options: WorkspaceRevisionPollerOptions) {
    this.getStorageDataVersion = options.getStorageDataVersion;
    this.getWorkspaceRevision = options.getWorkspaceRevision;
    this.onExternalRevisions = options.onExternalRevisions;
    this.onRecovery = options.onRecovery;
    this.isActive = options.isActive;
    this.getAppliedRevision = options.getAppliedRevision;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearSchedule = options.clearSchedule ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.activeIntervalMs = options.activeIntervalMs ?? WORKSPACE_POLL_ACTIVE_MS;
    this.maxIntervalMs = options.maxIntervalMs ?? WORKSPACE_POLL_MAX_MS;
    this.idleFactor = options.idleFactor ?? WORKSPACE_POLL_IDLE_FACTOR;
    this.intervalMs = this.activeIntervalMs;
  }

  /** Start/resume polling. Always schedules an immediate tick. */
  start(): void {
    if (this.disposed) return;
    this.running = true;
    this.intervalMs = this.activeIntervalMs;
    this.tickNow();
  }

  /** Stop the timer; in-flight poll may finish but will not re-arm. */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.clearTimer();
  }

  /** Immediate poll (visibility/focus regain). Coalesces with in-flight. */
  tickNow(): void {
    if (this.disposed || !this.running) return;
    this.intervalMs = this.activeIntervalMs;
    if (this.pollInFlight) {
      this.pendingImmediate = true;
      return;
    }
    this.clearTimer();
    void this.runPoll();
  }

  /** Test/observability: number of repository poll attempts started. */
  getPollCount(): number {
    return this.pollCount;
  }

  /** Test/observability: current backoff interval. */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clearSchedule(this.timer);
      this.timer = null;
    }
  }

  private armTimer(): void {
    if (this.disposed || !this.running || !this.isActive()) return;
    this.clearTimer();
    const delay = this.intervalMs;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.runPoll();
    }, delay);
  }

  private async runPoll(): Promise<void> {
    if (this.disposed || !this.running || this.pollInFlight) return;
    if (!this.isActive()) {
      this.clearTimer();
      return;
    }

    this.pollInFlight = true;
    this.pollCount += 1;
    let sawChange = false;
    try {
      const dataVersion = await this.getStorageDataVersion();
      const appliedBefore = this.getAppliedRevision();
      const dataUnchanged =
        this.lastDataVersion !== undefined && dataVersion === this.lastDataVersion;
      // If a prior poll observed a higher revision but apply/recovery did not advance
      // the cursor, re-check even when data_version is sticky (failed recovery).
      const appliedBehindObserved =
        this.observedRevision !== undefined && appliedBefore < this.observedRevision;

      if (dataUnchanged && !appliedBehindObserved) {
        // Cheap idle path: no DB mutation and applied cursor is caught up.
      } else {
        const currentRevision = await this.getWorkspaceRevision();
        this.observedRevision = currentRevision;
        const applied = this.getAppliedRevision();
        if (currentRevision < applied) {
          await this.onRecovery('invariant');
          this.intervalMs = this.activeIntervalMs;
          // Do not commit lastDataVersion — recovery must re-run if it failed.
          return;
        }
        if (currentRevision > applied) {
          sawChange = true;
          await this.onExternalRevisions({
            afterRevision: applied,
            currentRevision,
          });
          // Only commit the cheap data_version cursor after apply/recovery advanced
          // the applied revision to (or past) what we observed. Otherwise the next
          // poll must re-enter even if data_version is unchanged.
          if (this.getAppliedRevision() >= currentRevision) {
            this.lastDataVersion = dataVersion;
          }
          this.intervalMs = this.activeIntervalMs;
        } else {
          // current === applied: no external work; safe to arm cheap path.
          this.lastDataVersion = dataVersion;
        }
      }
      if (!sawChange) {
        this.intervalMs = Math.min(
          this.maxIntervalMs,
          Math.max(this.activeIntervalMs, Math.floor(this.intervalMs * this.idleFactor)),
        );
      }
    } catch {
      this.intervalMs = Math.min(
        this.maxIntervalMs,
        Math.max(this.activeIntervalMs, Math.floor(this.intervalMs * this.idleFactor)),
      );
      try {
        await this.onRecovery('error');
      } catch {
        // Recovery is best-effort; backoff already applied.
      }
    } finally {
      this.pollInFlight = false;
      if (this.pendingImmediate) {
        this.pendingImmediate = false;
        if (this.running && this.isActive() && !this.disposed) {
          void this.runPoll();
          return;
        }
      }
      this.armTimer();
    }
  }
}
