export class WorkflowGraphRefreshPolicy {
  private dirtyWhileRequest = false;

  reset(): void {
    this.dirtyWhileRequest = false;
  }

  onPatch(requestInFlight: boolean, hasSettledError: boolean): 'ignore' | 'fetch' {
    if (hasSettledError) return 'ignore';
    if (requestInFlight) {
      this.dirtyWhileRequest = true;
      return 'ignore';
    }
    return 'fetch';
  }

  onResult(succeeded: boolean): boolean {
    const trailingRefresh = succeeded && this.dirtyWhileRequest;
    this.dirtyWhileRequest = false;
    return trailingRefresh;
  }
}
