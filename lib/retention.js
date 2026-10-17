export const LIMITS = Object.freeze({ jobs: 60, activity: 80, requests: 200, pending: 32, previewCount: 8, previewBytes: 128 * 1024 * 1024, requestBytes: 8 * 1024 * 1024, stateBytes: 16 * 1024 * 1024, requestAge: 30 * 86400000 });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
export const issuedAt = id => /^\d{13}-/.test(id) ? Number(id.slice(0, 13)) : null;
const active = job => ["queued", "running"].includes(job.status);

export function pruneState(state, now = Date.now()) {
  // Keep active jobs ahead of completed history. An extreme external load is
  // still bounded; the panel's own unresolved submissions have a separate cap.
  state.jobs = [...state.jobs.filter(active), ...state.jobs.filter(job => !active(job))].slice(0, LIMITS.jobs);
  state.activity = state.activity.slice(0, LIMITS.activity);
  let resultBytes = 0, kept = 0;
  for (const [id, entry] of Object.entries(state.requests).filter(([, entry]) => ["done", "acknowledged"].includes(entry.status)).sort((a, b) => b[1].at - a[1].at)) {
    const size = bytes(entry);
    if (kept >= LIMITS.requests || resultBytes + size > LIMITS.requestBytes || entry.at < now - LIMITS.requestAge) {
      const issued = issuedAt(id);
      if (issued === null) state.legacyRequestsClosed = true;
      else state.requestFloor = Math.max(state.requestFloor ?? 0, issued);
      delete state.requests[id];
    } else { kept++; resultBytes += size; }
  }
  let imageBytes = 0;
  const referenced = new Set();
  for (const job of state.jobs) {
    const images = job.previews ?? [];
    job.previews = images.slice(0, LIMITS.previewCount).filter(image => {
      if (referenced.has(image.id)) return true;
      if (imageBytes + image.bytes > LIMITS.previewBytes) return false;
      referenced.add(image.id); imageBytes += image.bytes; return true;
    });
    if (job.previews.length < images.length) job.previewsExpired = true;
  }
  // Large execution graphs need a byte bound as well as a job-count bound.
  if (bytes(state) > LIMITS.stateBytes) for (const job of [...state.jobs].reverse()) {
    if (!job.submittedWorkflow) continue;
    delete job.submittedWorkflow; job.replayExpired = true;
    if (bytes(state) <= LIMITS.stateBytes) break;
  }
  return referenced;
}

export function assertFreshRequest(state, id, now = Date.now()) {
  const issued = issuedAt(id);
  if (issued === null ? state.legacyRequestsClosed : issued <= (state.requestFloor ?? 0) || issued < now - LIMITS.requestAge || issued > now + 300000) throw new Error("この送信IDの保持期限は終了しています。自動再送はしません。ジョブを確認してください。");
  if (Object.values(state.requests).filter(entry => entry.status === "pending").length >= LIMITS.pending) throw new Error(`未確定の送信が${LIMITS.pending}件に達しています。新規送信を停止しました。ジョブと履歴を確認してください。`);
}
