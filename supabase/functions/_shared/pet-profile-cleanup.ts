export type CleanupJob = { id: string; pet_id: string; object_path: string };
export type CleanupErrorCode = 'STORAGE_DELETE_FAILED' | 'OBJECT_STILL_REFERENCED' | 'STORAGE_STATUS_UNKNOWN';

type CleanupOperations = {
  currentPath(petId: string): Promise<{ path: string | null; error: boolean }>;
  remove(path: string): Promise<{ error: boolean }>;
  finish(id: string, completed: boolean, errorCode: CleanupErrorCode | null): Promise<{ error: boolean }>;
};

/** Processes claimed jobs without ever deleting an object still referenced by a Pet. */
export async function processProfileCleanupJobs(jobs: CleanupJob[], operations: CleanupOperations): Promise<boolean> {
  let pending = false;
  for (const job of jobs) {
    let current: { path: string | null; error: boolean };
    try { current = await operations.currentPath(job.pet_id); }
    catch { current = { path: null, error: true }; }
    if (current.error) {
      try { await operations.finish(job.id, false, 'STORAGE_STATUS_UNKNOWN'); } catch { /* lease expiry makes the job retryable */ }
      pending = true;
      continue;
    }
    if (current.path === job.object_path) {
      try { await operations.finish(job.id, false, 'OBJECT_STILL_REFERENCED'); } catch { /* lease expiry makes the job retryable */ }
      pending = true;
      continue;
    }
    let removed: { error: boolean };
    try { removed = await operations.remove(job.object_path); }
    catch { removed = { error: true }; }
    let finished: { error: boolean };
    try { finished = await operations.finish(job.id, !removed.error, removed.error ? 'STORAGE_DELETE_FAILED' : null); }
    catch { finished = { error: true }; }
    pending ||= removed.error || finished.error;
  }
  return pending;
}

export async function enqueueProfileOrphan(
  enqueue: () => Promise<{ queued: boolean; error: boolean }>,
): Promise<'queued' | 'already_referenced' | 'failed'> {
  try {
    const result = await enqueue();
    if (result.error) return 'failed';
    return result.queued ? 'queued' : 'already_referenced';
  } catch {
    return 'failed';
  }
}
