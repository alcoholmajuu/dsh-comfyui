import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {readConnection,saveConnection,bridgeArgs} from "../lib/connection-config.js";
import {apply as applyBridge} from "../lib/bridge-plugin.js";

test("connection settings preserve OAuth cache, allow loopback HTTP and reject exposed HTTP",t=>{
 const home=mkdtempSync(join(tmpdir(),"comfy-connection-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
 let config=readConnection({home,env:{}});assert.equal(config.mcpUrl,"http://127.0.0.1:8790/mcp");assert.equal(config.authDir,join(home,".dsh","comfyui-oauth"));assert.ok(bridgeArgs(config).includes("--allow-http"));
 saveConnection({mcpUrl:"https://example.com/mcp"},{home});config=readConnection({home,env:{}});assert.equal(config.mcpUrl,"https://example.com/mcp");assert.equal(bridgeArgs(config).includes("--allow-http"),false);
 assert.equal(statSync(config.file).mode&0o777,0o600);
 for(const mcpUrl of ["http://example.com/mcp","https://user:secret@example.com/mcp","https://example.com/mcp?token=x"]){assert.throws(()=>saveConnection({mcpUrl},{home}));assert.equal(readConnection({home,env:{}}).mcpUrl,"https://example.com/mcp");}
 assert.equal(readConnection({home,env:{DSH_COMFYUI_MCP_URL:"http://127.0.0.1:8899/mcp"}}).mcpUrl,"http://127.0.0.1:8899/mcp");
});

test("DSH bridge derives executable and package paths at runtime and awaits native MCP registration",async()=>{
 let loaded,registered;const module={apply(){}};
 await applyBridge({loader:{import:async name=>{loaded=name;return module;}},plugin:async(plugin,config)=>{registered={plugin,config};}});
 assert.equal(loaded,"@deepseek-ai/dsh-mcp-client");assert.equal(registered.plugin,module);assert.equal(registered.config.serverName,"comfyui");assert.equal(registered.config.env.ELECTRON_RUN_AS_NODE,"1");assert.equal(registered.config.args[0],fileURLToPath(new URL("../scripts/bridge.mjs",import.meta.url)));assert.ok(registered.config.command);
});
