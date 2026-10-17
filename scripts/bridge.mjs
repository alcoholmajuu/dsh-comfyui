import { mkdirSync } from "node:fs";
import { readConnection,bridgeArgs } from "../lib/connection-config.js";
process.umask(0o077);
const config=readConnection();
mkdirSync(config.authDir,{recursive:true,mode:0o700});
process.env.MCP_REMOTE_CONFIG_DIR=config.authDir;
process.argv=[process.argv[0],new URL("../node_modules/mcp-remote/dist/proxy.js",import.meta.url).pathname,...bridgeArgs(config)];
await import("../node_modules/mcp-remote/dist/proxy.js");
