import { describe, expect, it } from 'vitest';
import { WorkflowCatalogRequestPolicy } from './workflow-catalog-request-policy';

describe('WorkflowCatalogRequestPolicy', () => {
  it('requests initial on first open', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    expect(policy.onOpen()).toMatchObject({ reason: 'initial' });
  });

  it('is single-flight: no second request while one is in flight', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    expect(policy.onOpen()).not.toBeNull();
    expect(policy.onOpen()).toBeNull();
    expect(policy.onReload()).toBeNull();
  });

  it('serves a held snapshot on reopen without a request', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId, true)).toBe(true);
    expect(policy.onOpen()).toBeNull();
  });

  it('reloads with reason reload once a snapshot is held', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId, true);

    const second = policy.onReload()!;
    expect(second.reason).toBe('reload');
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('drops a result whose requestId is not in flight', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;

    expect(policy.onResult('some-other-id', true)).toBe(false);
    expect(policy.onResult(first.requestId, true)).toBe(true);
    // Already settled: a duplicate reply is dropped too.
    expect(policy.onResult(first.requestId, true)).toBe(false);
  });

  it('a failed result settles without holding a snapshot, so retry refetches', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId, false)).toBe(true);

    const retry = policy.onReload()!;
    expect(retry.reason).toBe('reload');
  });

  it('a failed reload keeps the held snapshot so open does not refetch', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId, true);
    const reload = policy.onReload()!;
    policy.onResult(reload.requestId, false);

    expect(policy.onOpen()).toBeNull();
  });

  it('times out only the in-flight request', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;

    expect(policy.onTimeout('stale-id')).toBe(false);
    expect(policy.onTimeout(first.requestId)).toBe(true);
    expect(policy.onReload()).not.toBeNull();
  });

  it('does not let stale results or timeouts settle a newer request', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId, true)).toBe(true);
    const second = policy.onReload()!;

    expect(policy.onResult(first.requestId, false)).toBe(false);
    expect(policy.onTimeout(first.requestId)).toBe(false);
    expect(policy.onResult(second.requestId, true)).toBe(true);
  });

  it('settle clears the in-flight request while retaining a held snapshot', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId, true)).toBe(true);
    expect(policy.onReload()).not.toBeNull();
    policy.settle();

    expect(policy.onOpen()).toBeNull();
    expect(policy.onReload()).not.toBeNull();
  });

  it('reset clears both the in-flight request and the held snapshot', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId, true);
    policy.reset();

    expect(policy.onOpen()).toMatchObject({ reason: 'initial' });
  });
});
