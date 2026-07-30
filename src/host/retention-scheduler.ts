/**
 * Recurring host retention maintenance.
 *
 * The timer seam is injected so callers can deterministically drive passes in
 * tests. A pass is deliberately single-flight: an interval tick while storage
 * maintenance is running is skipped rather than overlapping repository writes.
 */
export const RETENTION_SCHEDULE_INTERVAL_MS = 30 * 60 * 1_000;

export type RetentionSchedulerOptions<TPass = void> = {
  runPass: () => Promise<TPass>;
  /** Receives completed pass evidence only; errors never cross this boundary. */
  onPassCompleted?: (pass: TPass) => void;
  /** Signals a failed pass without exposing raw storage error details. */
  onPassFailed?: () => void;
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
};

export class RetentionScheduler<TPass = void> {
  private readonly runPass: RetentionSchedulerOptions<TPass>['runPass'];
  private readonly onPassCompleted: ((pass: TPass) => void) | undefined;
  private readonly onPassFailed: (() => void) | undefined;
  private readonly intervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly clearSchedule: (handle: unknown) => void;

  private handle: unknown | undefined;
  private started = false;
  private disposed = false;
  private inFlight = false;

  constructor(options: RetentionSchedulerOptions<TPass>) {
    this.runPass = options.runPass;
    this.onPassCompleted = options.onPassCompleted;
    this.onPassFailed = options.onPassFailed;
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
    void this.runPass().then(
      (pass) => {
        this.onPassCompleted?.(pass);
        this.inFlight = false;
      },
      () => {
        // Retention is maintenance; a failed pass must not interrupt a user turn.
        // The callback exposes a safe failure count on the storage report channel.
        this.onPassFailed?.();
        this.inFlight = false;
      },
    );
  }
}
