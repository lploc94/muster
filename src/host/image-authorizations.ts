/**
 * Tracks image paths the host itself minted (native picker results, staged
 * clipboard copies) so `send` can refuse any attachment path it did not hand
 * out.
 *
 * Extension filtering in src/host/send-request.ts proves only that a path ends
 * in an image suffix, which a compromised or buggy webview can satisfy by
 * naming any readable file — an exfil target renamed to *.png. Workspace-root
 * confinement was rejected as the rule instead: a user may legitimately pick an
 * image from anywhere on disk.
 */

/** Ceiling on remembered paths. Eviction only costs the user a re-pick. */
export const MAX_AUTHORIZED_IMAGE_PATHS = 64;

export class ImagePathAuthorizations {
  /** Insertion order is the eviction order, so a Set is the whole structure. */
  private readonly paths = new Set<string>();

  constructor(private readonly max: number = MAX_AUTHORIZED_IMAGE_PATHS) {}

  /** Remember a host-minted path, evicting the least recently minted. */
  authorize(filePath: string): void {
    // Delete before add so re-minting an existing path refreshes its recency
    // rather than leaving it at its original eviction position.
    this.paths.delete(filePath);
    this.paths.add(filePath);
    while (this.paths.size > this.max) {
      const oldest = this.paths.values().next();
      if (oldest.done) break;
      this.paths.delete(oldest.value);
    }
  }

  /** Whether every candidate was minted by this host. Empty input passes. */
  authorizedAll(candidates: readonly string[] | undefined): boolean {
    if (!candidates) return true;
    return candidates.every((candidate) => this.paths.has(candidate));
  }

  get size(): number {
    return this.paths.size;
  }
}
