import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { StudioStore, ActionQueue, parseToolResult } from "./studio-state.js";
import { assertGraph } from "./graph.js";
import { assertArguments } from "./input-validation.js";
import { checkInputValues } from "./parameters.js";

export const CONTEXT_TOOL = "comfyui_operator_context", ACTION_TOOL = "comfyui_operator_action";
export const MUTATIONS = new Set(["generate_image", "edit_image", "inpaint_image", "run_workflow", "save_workflow", "delete_workflow", "free_vram", "import_image"]);
export const isOperator = agent => Boolean(agent?.ctx.tools.get(CONTEXT_TOOL, agent)?.comfyuiOperator);
export function canonicalName(name) {
  if(typeof name!=="string")throw new Error("ワークフロー名を指定してください。");
  let normalized=name.trim();
  while(normalized.endsWith(".json"))normalized=normalized.slice(0,-5).trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(normalized)||normalized.includes(".."))throw new Error("保存名には英数字・空白・._-を使用してください（80文字以内、..は不可）。");
  return normalized;
}
const runtimes = new Map();
export function getRuntime(dataDir = join(homedir(), ".dsh", "comfyui-studio")) {
  if (!runtimes.has(dataDir)) runtimes.set(dataDir, new OperatorRuntime(new StudioStore(dataDir)));
  return runtimes.get(dataDir);
}

export class OperatorRuntime {
  constructor(store) { this.store = store; this.queue = new ActionQueue(store); this.policy = new AsyncLocalStorage(); this.polls = new WeakMap(); this.errors = new WeakMap(); }
  async call(agent, tool, args, signal) {
    const result = await agent.ctx.tools.execute({ agent, name: `mcp__comfyui__${tool}`, arguments: args, callId: `operator-read-${randomUUID()}`, signal });
    return parseToolResult(result).data;
  }
  async validate(agent, workflow, signal) {
    assertGraph(workflow);
    const types = [...new Set(Object.values(workflow).map(node => node.class_type))], definitions = {};
    for (let i = 0; i < types.length; i += 20) Object.assign(definitions, await this.call(agent, "node_info", { node_types: types.slice(i, i + 20) }, signal));
    const report = await this.call(agent, "validate_workflow", { workflow }, signal);
    if (!Array.isArray(report.errors)) throw new Error("サーバーから有効な検証結果を取得できませんでした。");
    return { ...report, errors: [...report.errors, ...checkInputValues(workflow, definitions)] };
  }
  async prepare(exec, tool) {
    const args = exec.arguments;
    assertArguments(exec.agent.ctx.tools.get(exec.name,exec.agent)?.parameters,args);
    if(["generate_image","edit_image","inpaint_image"].includes(tool)&&!String(args.prompt??"").trim())throw new Error("空でないpromptを指定してください。");
    if(tool==="import_image"&&!String(args.image??"").trim())throw new Error("取り込む画像の参照を指定してください。");
    if(tool==="inpaint_image"&&!args.mask&&!args.regions?.length)throw new Error("maskまたはregionsを指定してください。");
    if(tool==="generate_image")for(const field of ["width","height"])if(args[field]!==undefined&&(!Number.isInteger(args[field])||args[field]<256||args[field]>2048))throw new Error(`${field}は256〜2048の整数を指定してください。`);
    if (tool === "edit_workflow" && args.save_as) throw new Error("edit_workflowは保存せずに編集してください。保存はcomfyui_operator_actionを使用します。");
    if (!["save_workflow", "run_workflow"].includes(tool)) return;
    let graph = args.workflow;
    if (!graph && tool === "run_workflow" && args.name) graph = (await this.call(exec.agent, "get_workflow", { name: args.name }, exec.signal)).workflow;
    assertGraph(graph); graph = structuredClone(graph);
    for (const [key, value] of Object.entries(args.inputs ?? {})) {
      const dot = key.indexOf("."), id = key.slice(0, dot), input = key.slice(dot + 1);
      if (dot < 1 || !graph[id] || !input) throw new Error(`入力上書き ${key} の対象ノードがありません。`);
      graph[id].inputs[input] = value;
    }
    const report = await this.validate(exec.agent, graph, exec.signal);
    if (report.errors.length) throw new Error(`ワークフローに検証エラーがあります: ${JSON.stringify(report.errors).slice(0, 1600)}`);
    // Freeze the graph checked above; subsequent library edits cannot switch it.
    exec.arguments = { ...args, workflow: graph };
    delete exec.arguments.inputs;
    if (tool === "save_workflow") {
      exec.arguments.name=canonicalName(args.name);
      if (args.force === true) throw new Error("検証を省略するforce保存には対応しません。");
    }
  }
  async execute(exec, next, options = {}) {
    const tool = exec.name.replace(/^mcp__comfyui__/, ""), policy = this.policy.getStore();
    if (policy?.dispatch?.agent === exec.agent && policy.dispatch.tool === tool) return next();
    if (tool === "edit_workflow" && exec.arguments.save_as) throw new Error("edit_workflowのsave_asは使用できません。編集後にcomfyui_operator_actionで検証・保存してください。");
    if (!MUTATIONS.has(tool)) return next();
    const overwrite = options.overwrite === true || (policy?.agent === exec.agent && policy.overwrite === true);
    // Request identity is assigned by Host, never by model arguments. A failed
    // submission also blocks different IDs until the user reconciles it in UI.
    const requestId = options.requestId ?? (policy?.agent === exec.agent ? policy.requestId : undefined);
    if (!requestId) throw new Error("変更操作はcomfyui_operator_contextのnextRequestIdを取得し、comfyui_operator_actionから実行してください。");
    const origin = options.origin ?? "agent";
    return this.queue.once(exec.agent.id, requestId, tool, exec.arguments, async () => {
      const result = await this.policy.run({ dispatch: { agent: exec.agent, tool } }, next);
      const { data } = parseToolResult(result);
      if(data.status==="unknown"&&data.job_id){
        const request=this.store.read(exec.agent.id).requests[requestId];
        request.job_id=data.job_id;this.store.write(exec.agent.id);
        throw new Error(`投入済みジョブ ${data.job_id} の状態が不明です。再生成せず、このIDを照合してください。`);
      }
      if (tool === "save_workflow" && data.saved === false) throw new Error("サーバーが保存を拒否しました。保存済みとは扱いません。");
      return result;
    }, async () => {
      if (Object.values(this.store.read(exec.agent.id).requests).some(entry => entry.status === "pending")) throw new Error("送信結果が不明な操作があります。自動再送・新規実行は停止しました。Studioでジョブを照合してください。");
      await this.prepare(exec, tool);
      if (tool === "save_workflow") {
        // New Gateways enforce no-clobber atomically; older servers retain
        // the preflight check without receiving unsupported schema fields.
        if (exec.agent.ctx.tools.get(exec.name, exec.agent)?.parameters?.properties?.overwrite)
          exec.arguments.overwrite = overwrite;
        const library = await this.call(exec.agent, "list_workflows", {}, exec.signal);
        const names = Array.isArray(library) ? library.map(row => row.name) : [...(library.workflows ?? []).map(row => row.name), ...(library.comfyui_canvas_only ?? []).map(row => typeof row === "string" ? row : row.name)];
        const targets=names.flatMap(name=>{try{return [canonicalName(name).toLowerCase()];}catch{return [];}});
        if (!overwrite && targets.includes(exec.arguments.name.toLowerCase())) throw new Error("同名のワークフローが存在します。別名にするか、依頼された上書きをcomfyui_operator_actionのoverwriteで明示してください。");
      }
    }, { origin });
  }
  acknowledge(sessionId, id) {
    const state = this.store.read(sessionId), request = state.requests[id];
    if (!request || request.status !== "pending") throw new Error("未確定の送信IDを指定してください。");
    if (this.queue.active.has(`${sessionId}:${id}`)) throw new Error("まだ送信処理中です。終了後にジョブを照合してください。");
    request.status = "acknowledged"; request.acknowledgedAt = Date.now();
    state.activity = [{ tool: "acknowledge_request", origin: "panel", at: Date.now() }, ...state.activity];
    this.store.write(sessionId);
    return { acknowledged: id, outcome: "unknown", message: "結果は未確定のまま記録し、新しい実行を許可しました。同じ送信IDは再実行しません。" };
  }
  shareDraft(sessionId, record) {
    assertGraph(record.workflow);
    if (JSON.stringify(record).length > 4 * 1024 * 1024) throw new Error("下書きが大きすぎます。");
    const shared = { workflow: structuredClone(record.workflow), name: String(record.name ?? ""), description: String(record.description ?? ""), sharedAt: Date.now(), revision: randomUUID() };
    this.store.read(sessionId).sharedDraft = shared; this.store.write(sessionId); return shared;
  }
  resetPolls(agent) { this.polls.set(agent, { started: Date.now(), count: 0, failed: false }); this.errors.set(agent,0); }
  observeResult(exec,result) {
    // Nested Host reads/actions and panel activity are not additional model
    // attempts. Count one failure at the model-facing outer call only.
    if (/^(studio-|operator-read-|operator-action-)/.test(exec.callId)) return;
    if(result.isError)this.errors.set(exec.agent,(this.errors.get(exec.agent)??0)+1);
  }
  checkPoll(exec) {
    if (!this.polls.has(exec.agent)) this.resetPolls(exec.agent);
    const poll = this.polls.get(exec.agent);
    if (poll.failed || poll.count >= 6 || Date.now() - poll.started > 300000) {
      exec.concludeTurn?.();
      throw new Error("このターンのジョブ確認は終了しました。既知のjob_idと現状を報告し、Studioの追跡に引き継いでください。自動再生成は禁止です。");
    }
    poll.count++;
    const remaining=Math.max(0,Math.floor((300000-(Date.now()-poll.started))/1000));
    exec.arguments={...exec.arguments,wait_seconds:Math.min(50,Math.max(0,exec.arguments.wait_seconds??50),remaining)};
  }
}
