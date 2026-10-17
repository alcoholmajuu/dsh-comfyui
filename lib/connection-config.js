import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import {randomUUID} from "node:crypto";

export const DEFAULT_MCP_URL = "http://127.0.0.1:8790/mcp";
export function readConnection({env=process.env,home=homedir(),file=join(home,".dsh","dsh-comfyui","connection.json")}={}) {
  let saved={};
  try {saved=JSON.parse(readFileSync(file,"utf8"));}catch(error){if(error.code!=="ENOENT")throw new Error("ComfyUI接続設定を読み込めません。");}
  const url=new URL(env.DSH_COMFYUI_MCP_URL||saved.mcpUrl||DEFAULT_MCP_URL);
  const loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||(url.protocol==="http:"&&loopback)))throw new Error("MCP URLはHTTPS、またはローカルループバックHTTPで指定してください。URLに認証情報やクエリは含められません。");
  const authDir=env.DSH_COMFYUI_AUTH_DIR||saved.authDir||join(home,".dsh","comfyui-oauth");
  if(typeof authDir!=="string"||!isAbsolute(authDir))throw new Error("OAuth保存先には絶対パスを指定してください。");
  return {mcpUrl:url.href,authDir,nodeCommand:env.DSH_COMFYUI_NODE||saved.nodeCommand||process.execPath,allowHttp:url.protocol==="http:",file};
}
export function saveConnection(values,{home=homedir()}={}) {
  const folder=join(home,".dsh","dsh-comfyui"),file=join(folder,"connection.json");
  let previous={};try{previous=JSON.parse(readFileSync(file,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
  const config={};for(const key of ["mcpUrl","authDir","nodeCommand"]){const value=values[key]??previous[key];if(value!==undefined)config[key]=value;}
  // Validate the exact values before replacing the saved configuration.
  mkdirSync(folder,{recursive:true,mode:0o700});
  const temporary=join(folder,`connection.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary,JSON.stringify(config,null,2)+"\n",{mode:0o600});
    readConnection({home,env:{},file:temporary});
    renameSync(temporary,file);
  }finally{try{unlinkSync(temporary);}catch(error){if(error.code!=="ENOENT")throw error;}}
  return readConnection({home,env:{},file});
}
export function bridgeArgs(config){return [config.mcpUrl,"--transport","http-only","--auth-timeout","300",...(config.allowHttp?["--allow-http"]:[])];}
