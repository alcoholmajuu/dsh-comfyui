import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseToolResult } from "./studio-state.js";
import { getRuntime, isOperator } from "./operator-runtime.js";
import { assertGraph } from "./graph.js";


export const name = "comfyui-studio";
export const inject = ["connection", "agents", "tools", "sessionController"];
const READ = new Set(["comfy_status", "list_workflows", "get_workflow", "node_info", "list_models", "validate_workflow", "get_job"]);
const WRITE = new Set(["save_workflow", "run_workflow"]);

export function apply(ctx, { dataDir = join(homedir(), ".dsh", "comfyui-studio") } = {}) {
  const runtime = getRuntime(dataDir), store = runtime.store, captured = new WeakSet();
  ctx.on("agent/pre-step", async ({agent,step},next) => {
    if(isOperator(agent)) {
      if(step===1)runtime.resetPolls(agent);
      else if((runtime.errors.get(agent)??0)>=2)return {kind:"reject",reason:"ツールエラーが続いたため、このターンの自動再試行を停止しました。直前のエラーを確認してください。"};
    }
    return next();
  }, {global:true});
  ctx.on("tools/execute", async (exec,next) => {
    if(!isOperator(exec.agent)||!exec.name.startsWith("mcp__comfyui__"))return next();
    const tool=exec.name.slice("mcp__comfyui__".length);
    if(tool==="get_job"&&!runtime.policy.getStore()?.panel){runtime.checkPoll(exec);const result=await next();if(result.isError)runtime.polls.get(exec.agent).failed=true;return result;}
    return runtime.execute(exec,next);
  },{global:true});
  ctx.on("tools/result", (exec, result) => {
    if(isOperator(exec.agent))runtime.observeResult(exec,result);
    if (!isOperator(exec.agent) || !exec.name.startsWith("mcp__comfyui__") || result.isError) return;
    try {
      store.capture(exec.agent.id, exec.name.slice("mcp__comfyui__".length), exec.arguments, result, exec.callId.startsWith("studio-") ? "panel" : "agent");
      captured.add(result);
    } catch (e) { ctx.logger.warn(`ComfyUI Studio capture failed: ${e.message}`); }
  }, { global: true });

  async function callRaw(agent, tool, args, signal) {
    const fullName = `mcp__comfyui__${tool}`;
    if (!agent.ctx.tools.get(fullName, agent)) throw new Error("ComfyUI Operatorセッションを選択してください。");
    const result = await agent.ctx.tools.execute({ agent, name: fullName, arguments: args, callId: `studio-${randomUUID()}`, signal });
    parseToolResult(result);
    if (!captured.has(result)) store.capture(agent.id, tool, args, result, "panel");
    return result;
  }
  async function call(agent, tool, args, signal) {return parseToolResult(await runtime.policy.run({panel:true},()=>callRaw(agent,tool,args,signal))).data;}

  ctx.connection.fetch.register({
    path: "/api/comfyui-studio", methods: ["POST"], requestBody: "buffered",
    async fetch(request) {
      let rpcId = "invalid";
      try {
        const body = await request.json(); rpcId = body.rpcId;
        if (body.type !== "client-request" || body.method !== "comfyui-studio" || typeof rpcId !== "string") throw new Error("Invalid Studio request");
        if (JSON.stringify(body).length > 4 * 1024 * 1024) throw new Error("Workflow request is too large");
        const { sessionId, action, tool, args = {}, requestId, overwrite = false } = body.payload ?? {};
        store.path(sessionId);
        let agent = ctx.agents.get(sessionId);
        if (!agent && ctx.sessionController) {
          const resolved = await ctx.sessionController.resolveAgent(sessionId);
          if (resolved.error) throw resolved.error;
          agent = resolved.agent;
        }
        if (!isOperator(agent) || !agent.ctx.tools.get("mcp__comfyui__comfy_status", agent)) throw new Error("ComfyUI Operatorでセッションを開いてください。");
        let value;
        if (action === "snapshot") value = store.snapshot(sessionId);
        else if (action === "asset") value = store.asset(sessionId, body.payload.id);
        else if (action === "share_draft") {runtime.shareDraft(sessionId, body.payload.draft ?? {});value=store.snapshot(sessionId).sharedDraft;}
        else if (action === "acknowledge_request") value = runtime.acknowledge(sessionId, body.payload.id);
        else if (action === "call" && READ.has(tool)) {
          value = tool === "validate_workflow" ? await runtime.validate(agent, args.workflow, request.signal) : await call(agent, tool, tool === "get_job" ? { ...args, wait_seconds: 0 } : args, request.signal);
        } else if (action === "call" && WRITE.has(tool)) {
          assertGraph(args.workflow);
          const clean = tool === "run_workflow" ? { workflow: args.workflow, ...(args.name ? { name: String(args.name) } : {}), wait_seconds: 0 } : { name: args.name, workflow: args.workflow, description: String(args.description ?? "") };
          const exec = {agent,name:`mcp__comfyui__${tool}`,arguments:clean,signal:request.signal,callId:`studio-${randomUUID()}`};
          const result = await runtime.execute(exec, () => callRaw(agent,tool,exec.arguments,request.signal), {requestId,overwrite,origin:"panel"});
          value = parseToolResult(result).data;
        } else throw new Error("Unsupported Studio action");
        return Response.json({ type: "server-response", rpcId, result: { ok: true, value } }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return Response.json({ type: "server-response", rpcId, result: { ok: false, error: { code: "studio/error", message: error.message, details: {} } } }, { headers: { "Cache-Control": "no-store" } });
      }
    },
  });
}
