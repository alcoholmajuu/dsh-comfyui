import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LIMITS, pruneState, assertFreshRequest } from "./retention.js";

export function parseToolResult(result) {
  if (result.isError) throw new Error(result.error?.message || result.content?.find(x => x.type === "text")?.text || "MCP tool failed");
  const blocks = result.value?.content ?? result.content ?? [];
  const text = blocks.find(x => x.type === "text")?.text;
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text ?? "" }; }
  return { data, images: blocks.filter(x => x.type === "image" && typeof x.data === "string") };
}

export class StudioStore {
  constructor(root) { this.root = root; this.cache = new Map(); this.pins = new Map(); mkdirSync(root, { recursive: true, mode: 0o700 }); }
  trimCache(current) {
    for (const id of this.cache.keys()) {
      if (this.cache.size <= 16) break;
      if (id !== current && !this.pins.has(id)) this.cache.delete(id);
    }
  }
  retain(sessionId) {
    this.pins.set(sessionId, (this.pins.get(sessionId) ?? 0) + 1);
    return () => { const count = this.pins.get(sessionId) - 1; if (count) this.pins.set(sessionId, count); else this.pins.delete(sessionId); this.trimCache(); };
  }
  path(sessionId) {
    if (!/^session-[a-zA-Z0-9-]{1,100}$/.test(sessionId)) throw new Error("Invalid Session identity");
    return join(this.root, sessionId);
  }
  read(sessionId) {
    if (this.cache.has(sessionId)) { const state = this.cache.get(sessionId); this.cache.delete(sessionId); this.cache.set(sessionId, state); return state; }
    const folder = this.path(sessionId);
    let state;
    try { state = JSON.parse(readFileSync(join(folder, "state.json"), "utf8")); } catch (e) {
      if (e.code !== "ENOENT") throw new Error("Studio state cannot be read; refusing to replace it");
    }
    state ??= { version: 1, jobs: [], activity: [], requests: {}, latestWorkflow: null, status: null };
    if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error("Unsupported Studio state version");
    this.cache.set(sessionId, state);
    // Migrate old unbounded request results and orphan previews, too.
    this.write(sessionId);
    this.trimCache(sessionId);
    return state;
  }
  write(sessionId) {
    const folder = this.path(sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, "state.json");
    const state = this.read(sessionId), referenced = pruneState(state);
    writeFileSync(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
    renameSync(file + ".tmp", file);
    // Only after the atomic state commit: a failed write must not remove an
    // image still referenced by the previous on-disk state.
    try { for (const id of readdirSync(join(folder, "images"))) if (/^[a-f0-9]{64}$/.test(id) && !referenced.has(id)) unlinkSync(join(folder, "images", id)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  image(sessionId, image) {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) throw new Error("Unsupported preview format");
    if (image.data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(image.data)) throw new Error("Invalid or oversized image preview");
    const bytes = Buffer.from(image.data, "base64");
    const id = createHash("sha256").update(bytes).digest("hex");
    const folder = join(this.path(sessionId), "images"); mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, id), bytes, { mode: 0o600 });
    return { id, mimeType: image.mimeType, bytes: bytes.length };
  }
  asset(sessionId, id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid image identity");
    const image = this.read(sessionId).jobs.flatMap(j => j.previews ?? []).find(p => p.id === id);
    if (!image) throw new Error("Image does not belong to this Session");
    return `data:${image.mimeType};base64,${readFileSync(join(this.path(sessionId), "images", id)).toString("base64")}`;
  }
  capture(sessionId, tool, args, result, origin = "agent") {
    const { data, images } = parseToolResult(result);
    const state = this.read(sessionId), now = Date.now();
    const previousJob = data.job_id && state.jobs.find(job => job.job_id === data.job_id);
    if (origin === "panel" && tool === "get_job" && previousJob && !images.length && Object.entries(data).every(([key, value]) => JSON.stringify(previousJob[key]) === JSON.stringify(value))) return data;
    if (tool === "comfy_status") state.status = { ...data, checkedAt: now };
    if (data.job_id) {
      const previous = state.jobs.find(j => j.job_id === data.job_id) ?? {};
      const job = { ...previous, ...data, updatedAt: now, createdAt: previous.createdAt ?? now,
        source: previous.source ?? tool, prompt: previous.prompt ?? args.prompt,
        workflowName: previous.workflowName ?? args.name,
        previews: images.length ? images.slice(0, LIMITS.previewCount).map(image => this.image(sessionId, image)) : previous.previews ?? [] };
      if (images.length > LIMITS.previewCount) job.previewsExpired = true;
      // Capture the submitted draft, not a mutable library entry. Polling never
      // replaces this record; legacy jobs simply have no replay controls.
      if (!previous.submittedWorkflow && tool === "run_workflow" && args.workflow) {
        const workflow = structuredClone(args.workflow);
        for (const [key, value] of Object.entries({ ...args.inputs, ...data.seeds })) {
          const dot = key.indexOf("."), id = key.slice(0, dot), input = key.slice(dot + 1);
          if (dot > 0 && workflow[id]) workflow[id].inputs[input] = structuredClone(value);
        }
        job.submittedWorkflow = { workflow, name: args.name ?? "", description: "" };
      }
      state.jobs = [job, ...state.jobs.filter(j => j.job_id !== data.job_id)];
      if(tool==="get_job"&&["done","failed"].includes(data.status))for(const request of Object.values(state.requests)){
        if(request.status==="pending"&&request.job_id===data.job_id){request.status="done";request.value=result;request.resolvedAt=now;}
      }
    }
    const graph = data.workflow ?? ((tool === "save_workflow" && data.saved !== false) ? args.workflow : null);
    if (graph && typeof graph === "object") state.latestWorkflow = {
      name: data.name ?? args.save_as ?? args.name ?? "", workflow: graph,
      description: data.description ?? args.description ?? "", revision: now, origin,
    };
    // Background reads should not bury the user's actual operations.
    const previousActivity = state.activity.find(entry => entry.job_id === data.job_id && entry.tool === tool);
    if (!(origin === "panel" && tool === "comfy_status") && !(origin === "panel" && tool === "get_job" && previousActivity?.status === data.status)) state.activity = [{ tool, origin, at: now, job_id: data.job_id, status: data.status, name: args.name ?? args.save_as }, ...state.activity].slice(0, LIMITS.activity);
    this.write(sessionId);
    return data;
  }
  snapshot(sessionId) {
    const { requests, sharedDraft, ...state } = this.read(sessionId);
    return { ...state, sharedDraft: sharedDraft ? { name: sharedDraft.name, description: sharedDraft.description, sharedAt: sharedDraft.sharedAt, revision: sharedDraft.revision, nodes: Object.keys(sharedDraft.workflow).length } : null, retention: { jobs: LIMITS.jobs, activity: LIMITS.activity, previewMB: LIMITS.previewBytes / 1024 / 1024, requests: LIMITS.requests, pending: LIMITS.pending }, uncertainRequests: Object.entries(requests).filter(([,r]) => r.status === "pending").map(([id, r]) => ({ id, tool: r.tool, at: r.at, ...(r.origin ? {origin:r.origin} : {}),...(r.job_id?{job_id:r.job_id}:{}) })) };
  }
}

export class ActionQueue {
  constructor(store) { this.store = store; this.active = new Map(); this.tails = new Map(); }
  async once(sessionId, requestId, tool, args, run, preflight, { origin } = {}) {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(requestId ?? "")) throw new Error("A request identity is required");
    const fingerprint = createHash("sha256").update(JSON.stringify({ tool, args })).digest("hex");
    const key = `${sessionId}:${requestId}`, state = this.store.read(sessionId), existing = state.requests[requestId];
    if (existing && existing.fingerprint !== fingerprint) throw new Error("Request identity reused with different inputs");
    const active = this.active.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Error("Request identity reused with different inputs");
      return active.promise;
    }
    if (existing?.status === "done") return existing.value;
    if (existing) throw new Error("The previous request may have been submitted. Check jobs before submitting a new request.");
    assertFreshRequest(state, requestId);
    const release = this.store.retain(sessionId);
    const task = (this.tails.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      assertFreshRequest(state, requestId);
      await preflight?.();
      state.requests[requestId] = { status: "pending", tool, fingerprint, at: Date.now(), ...(origin ? { origin } : {}) };
      this.store.write(sessionId);
      try {
        const value = await run();
        state.requests[requestId] = { ...state.requests[requestId], status: "done", value };
        this.store.write(sessionId); return value;
      } catch (error) {
        // Preserve pending on uncertain network failure; never automatically resubmit.
        this.store.write(sessionId); throw error;
      }
    });
    this.active.set(key, { promise: task, fingerprint }); this.tails.set(sessionId, task);
    try { return await task; } finally { this.active.delete(key); if (this.tails.get(sessionId) === task) this.tails.delete(sessionId); release(); }
  }
}
