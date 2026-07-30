/**
 * Recurring host retention maintenance.
 *
 * The timer seam is injected so callers can deterministically drive passes in
 * tests. A pass is deliberately single-flight: an interval tick while storage
 * maintenance is running is skipped rather than overlapping repository writes.
 */
export const RETENTION_SCHEDULE_INTERVAL_MS = 30 * 60 * 1_000;

export type RetentionSchedulerOptions = {
  runPass: () => Promise<void>;
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
};

export class RetentionScheduler {
  private readonly runPass: RetentionSchedulerOptions['runPass'];
  private readonly intervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly clearSchedule: (handle: unknown) => void;

  private handle: unknown | undefined;
  private started = false;
  private disposed = false;
  private inFlight = false;

  constructor(options: RetentionSchedulerOptions) {
    this.runPass = options.runPass;
    this.intervalMs = options.intervalMs ?? RETENTION_SCHEDULE_INTERVAL_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms));
    this.clearSchedule = options.clearSchedule ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  /** Starts immediate maintenance and subsequent recurring passes. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.handle = this.schedule(() => this.trigger(), this.intervalMs);
    this.trigger();
  }

  dispose(): void {
    this.disposed = true;
    if (this.handle !== undefined) {
      this.clearSchedule(this.handle);
      this.handle = undefined;
    }
  }

  private trigger(): void {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    void this.runPass()
      .catch(() => {
        // Retention is maintenance; a failed pass must not interrupt a user turn.
      })
      .finally(() => {
        this.inFlight = false;
      });
  }
}
