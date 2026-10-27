import { describe, expect, it } from 'vitest';
import { enqueueProfileOrphan, processProfileCleanupJobs, type CleanupJob } from './pet-profile-cleanup';

const job: CleanupJob = {
  id: 'cleanup-job-1',
  pet_id: 'pet-1',
  object_path: 'pet-1/0123456789abcdef0123456789abcdef.jpg',
};

describe('profile photo compensation and cleanup', () => {
  it('queues an ambiguous failed-save object before deletion', async () => {
    const order: string[] = [];
    const outcome = await enqueueProfileOrphan(async () => {
      order.push('enqueue');
      return { queued: true, error: false };
    });
    expect(outcome).toBe('queued');
    expect(order).toEqual(['enqueue']);
  });

  it('does not queue or remove an object already referenced by the Pet', async () => {
    const outcome = await enqueueProfileOrphan(async () => ({ queued: false, error: false }));
    expect(outcome).toBe('already_referenced');
  });

  it('keeps a currently referenced object and records a retryable safety state', async () => {
    const calls: unknown[][] = [];
    const pending = await processProfileCleanupJobs([job], {
      currentPath: async () => ({ path: job.object_path, error: false }),
      remove: async () => { calls.push(['remove']); return { error: false }; },
      finish: async (...args) => { calls.push(args); return { error: false }; },
    });
    expect(pending).toBe(true);
    expect(calls).toEqual([['cleanup-job-1', false, 'OBJECT_STILL_REFERENCED']]);
  });

  it('preserves failed deletes for retry and marks successful deletes complete', async () => {
    const calls: unknown[][] = [];
    let removeAttempts = 0;
    const jobs = [job, { ...job, id: 'cleanup-job-2', object_path: 'pet-1/1123456789abcdef0123456789abcdef.jpg' }];
    const pending = await processProfileCleanupJobs(jobs, {
      currentPath: async () => ({ path: null, error: false }),
      remove: async () => ({ error: ++removeAttempts === 1 }),
      finish: async (...args) => { calls.push(args); return { error: false }; },
    });
    expect(pending).toBe(true);
    expect(calls).toEqual([
      ['cleanup-job-1', false, 'STORAGE_DELETE_FAILED'],
      ['cleanup-job-2', true, null],
    ]);
  });

  it('does not delete when the current Pet state cannot be checked', async () => {
    let removed = false;
    const pending = await processProfileCleanupJobs([job], {
      currentPath: async () => ({ path: null, error: true }),
      remove: async () => { removed = true; return { error: false }; },
      finish: async () => ({ error: false }),
    });
    expect(pending).toBe(true);
    expect(removed).toBe(false);
  });

  it('converts thrown Storage/network errors into durable retry state', async () => {
    const finished: unknown[][] = [];
    const pending = await processProfileCleanupJobs([job], {
      currentPath: async () => ({ path: null, error: false }),
      remove: async () => { throw new Error('network detail must not escape'); },
      finish: async (...args) => { finished.push(args); return { error: false }; },
    });
    expect(pending).toBe(true);
    expect(finished).toEqual([['cleanup-job-1', false, 'STORAGE_DELETE_FAILED']]);
  });

  it('reports queue insertion failure without attempting an unsafe direct delete', async () => {
    const outcome = await enqueueProfileOrphan(async () => ({ queued: false, error: true }));
    expect(outcome).toBe('failed');
  });
});
