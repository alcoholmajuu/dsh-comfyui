import {fileURLToPath} from "node:url";
import {readConnection} from "./connection-config.js";
export const name="dsh-comfyui-bridge";
export const inject=["tools","loader"];
export async function apply(ctx) {
  const connection=readConnection();
  const mcp=await ctx.loader.import("@deepseek-ai/dsh-mcp-client");
  await ctx.plugin(mcp.default??mcp,{
    serverName:"comfyui",transport:"stdio",command:connection.nodeCommand,
    args:[fileURLToPath(new URL("../scripts/bridge.mjs",import.meta.url))],
    env:{ELECTRON_RUN_AS_NODE:"1",DSH_COMFYUI_MCP_URL:connection.mcpUrl,DSH_COMFYUI_AUTH_DIR:connection.authDir},
    cwd:fileURLToPath(new URL("../",import.meta.url)),toolCallTimeoutMs:120000,failOnStartupError:true,
  });
}
