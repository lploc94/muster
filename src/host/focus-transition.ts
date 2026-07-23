export class LatestFocusTransition {
  private generation = 0;

  async run(
    flushPrevious: () => Promise<void>,
    applyFocus: () => Promise<void>,
  ): Promise<boolean> {
    const generation = ++this.generation;
    await flushPrevious();
    if (generation !== this.generation) return false;
    await applyFocus();
    return true;
  }
}
