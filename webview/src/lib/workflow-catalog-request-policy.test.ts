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

  it('revalidates the active workspace with initial after a settled reopen', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId)).toBe(true);

    const reopened = policy.onOpen()!;
    expect(reopened.reason).toBe('initial');
    expect(reopened.requestId).not.toBe(first.requestId);
  });

  it('reloads with reason reload once the prior request settles', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId);

    const second = policy.onReload()!;
    expect(second.reason).toBe('reload');
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('drops a result whose requestId is not in flight', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;

    expect(policy.onResult('some-other-id')).toBe(false);
    expect(policy.onResult(first.requestId)).toBe(true);
    // Already settled: a duplicate reply is dropped too.
    expect(policy.onResult(first.requestId)).toBe(false);
  });

  it('a failed result settles so retry refetches', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId)).toBe(true);

    const retry = policy.onReload()!;
    expect(retry.reason).toBe('reload');
  });

  it('revalidates with initial after a failed reload settles', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId);
    const reload = policy.onReload()!;
    policy.onResult(reload.requestId);

    expect(policy.onOpen()).toMatchObject({ reason: 'initial' });
  });

  it('times out only the in-flight request', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;

    expect(policy.onTimeout('stale-id')).toBe(false);
    expect(policy.onTimeout(first.requestId)).toBe(true);
    expect(policy.onTimeout(first.requestId)).toBe(false);
    expect(policy.onReload()).not.toBeNull();
  });

  it('does not let stale results or timeouts settle a newer request', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId)).toBe(true);
    const second = policy.onReload()!;

    expect(policy.onResult(first.requestId)).toBe(false);
    expect(policy.onTimeout(first.requestId)).toBe(false);
    expect(policy.onResult(second.requestId)).toBe(true);
  });
});
