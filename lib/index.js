import { randomUUID } from "node:crypto";
import { apply as applyStudio } from "./studio.js";
import { getRuntime, CONTEXT_TOOL, ACTION_TOOL, MUTATIONS } from "./operator-runtime.js";
import { parseToolResult } from "./studio-state.js";

export const name = "comfyui-operator-scope";
export const inject = ["tools", "connection", "agents", "sessionController"];
const READ = new Set(["comfy_status", "list_workflows", "get_workflow", "node_info", "list_models", "validate_workflow", "get_job", "edit_workflow"]);
const allowed = name => name === CONTEXT_TOOL || name === ACTION_TOOL || name === "ask_user_question" || (name.startsWith("mcp__comfyui__") && (READ.has(name.slice("mcp__comfyui__".length)) || MUTATIONS.has(name.slice("mcp__comfyui__".length))));
const output = { schema: { type: "object", additionalProperties: true }, render: (_args, value) => value.content ?? [{ type: "text", text: JSON.stringify(value) }] };

export function apply(ctx, config = {}) {
  if (config.role === "studio") return applyStudio(ctx, config);
  const runtime = getRuntime(config.dataDir);
  const contextTool = {
    name: CONTEXT_TOOL, comfyuiOperator: true,
    description: "Read this Operator session's jobs, uncertain submissions and explicitly shared panel draft. Returns nextRequestId for one mutation; reuse the same ID when checking a repeated call, never mint a replacement to bypass an error. includeDraft=true retrieves the shared graph snapshot.",
    parameters: { type: "object", properties: { includeDraft: { type: "boolean", default: false } }, additionalProperties: false },
    output,
    execute(args, exec) {
      const state = runtime.store.snapshot(exec.agent.id), shared = runtime.store.read(exec.agent.id).sharedDraft;
      return { nextRequestId: `${Date.now()}-${randomUUID()}`, uncertainRequests: state.uncertainRequests,
        jobs: state.jobs.slice(0, 8).map(job => ({ job_id: job.job_id, status: job.status ?? "unknown", workflowName: job.workflowName ?? null })),
        sharedDraft: shared ? (args.includeDraft === true ? shared : { name: shared.name, sharedAt: shared.sharedAt, revision: shared.revision, nodes: Object.keys(shared.workflow).length }) : null,
        draftNotice: "Only an explicitly shared snapshot is readable. It is not necessarily the current browser draft; ask the user to share again when needed." };
    },
  };
  ctx.tools.register(contextTool);
  ctx.tools.register({
    name: ACTION_TOOL,
    description: "Execute a requested ComfyUI mutation with durable duplicate/uncertainty protection. Get nextRequestId from comfyui_operator_context first. For save_workflow set overwrite=true only when the user already requested overwriting that exact name. Other arguments match the corresponding mcp__comfyui__ tool. Never retry an uncertain operation with a new ID.",
    parameters: { type: "object", properties: { requestId: { type: "string" }, tool: { type: "string", enum: [...MUTATIONS] }, arguments: { type: "object", additionalProperties: true }, overwrite: { type: "boolean", default: false } }, required: ["requestId", "tool", "arguments"], additionalProperties: false },
    output,
    async execute(args, exec) {
      if (!MUTATIONS.has(args.tool) || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw new Error("対応する変更操作と引数を指定してください。");
      const mutation = { agent: exec.agent, name: `mcp__comfyui__${args.tool}`, arguments: args.arguments, callId: `operator-action-${randomUUID()}`, signal: exec.signal };
      const result = await runtime.execute(mutation, () => exec.agent.ctx.tools.execute(mutation), {requestId:args.requestId,overwrite:args.tool === "save_workflow" && args.overwrite === true,origin:"agent"});
      const { data } = parseToolResult(result);
      return { data, content: result.content ?? result.value?.content ?? [{ type: "text", text: JSON.stringify(data) }] };
    },
  });
  const restricted = new WeakSet();
  ctx.on("agent/created", ({ agent }) => {
    if (restricted.has(agent) || agent.ctx.tools.get(CONTEXT_TOOL, agent) !== contextTool) return;
    const allow = agent.ctx.tools.schemas(agent).map(tool => tool.name).filter(allowed);
    agent.ctx.tools.restrict({ allow });
    restricted.add(agent);
  }, { global: true });
  // Explicit capability list; additions to a remote namespace are not admitted
  // automatically. The scoped marker above identifies this preset's Agents.
  ctx.tools.guard(exec => {
    if (exec.agent?.ctx.tools.get(CONTEXT_TOOL, exec.agent) !== contextTool) return;
    if (!allowed(exec.name)) return "ComfyUI Operator only permits its ComfyUI tools and user questions";
    const tool=exec.name.slice("mcp__comfyui__".length),policy=runtime.policy.getStore();
    if(exec.name.startsWith("mcp__comfyui__")&&MUTATIONS.has(tool)&&!(policy?.dispatch?.agent===exec.agent&&policy.dispatch.tool===tool)) return "変更操作はcomfyui_operator_contextの送信IDとcomfyui_operator_actionを使用してください。";
  });
}
