import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn(process.execPath, [new URL("bridge.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let seq = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  try {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  } catch { /* Ignore non-RPC lines; the deadline still bounds a broken bridge. */ }
});
child.stderr.resume();
function failPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}
child.on("error", failPending);
child.on("exit", code => failPending(new Error(`bridge exited (${code})`)));
function send(message) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out; run npm run login to authenticate`));
    }, 45000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "dsh-comfyui-verify", version: "0.1.0" },
  });
  send({ method: "notifications/initialized" });
  console.log(JSON.stringify({ initialize: "ok", server: init.serverInfo }));
  const tools = await rpc("tools/list");
  const names = tools.tools.map(tool => tool.name);
  for (const name of ["comfy_status", "node_info", "validate_workflow", "run_workflow", "get_job"]) {
    if (!names.includes(name)) throw new Error(`required tool missing: ${name}`);
  }
  console.log(JSON.stringify({ toolCount: names.length, tools: names }));
  if (!process.argv.includes("--discovery-only")) {
  const status = await rpc("tools/call", { name: "comfy_status", arguments: {} });
  if (status.isError) throw new Error("comfy_status returned isError");
  const content = status.content.find(block => block.type === "text");
  const details = JSON.parse(content.text);
  if (!details.comfyui_version || !details.gpu) throw new Error("unexpected ComfyUI status response");
  console.log(JSON.stringify({ status: "ok", ...details }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  lines.close();
  child.stdin.end();
  child.kill("SIGTERM");
}
