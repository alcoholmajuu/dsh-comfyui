import {spawn} from "node:child_process";
import {existsSync,readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const root=fileURLToPath(new URL("../gateway/",import.meta.url));
const venv=join(root,".venv",process.platform==="win32"?"Scripts":"bin",process.platform==="win32"?"python.exe":"python");
const python=process.env.DSH_COMFYUI_PYTHON||(existsSync(venv)?venv:process.platform==="win32"?"python":"python3");
const env={...process.env};
const envFile=process.env.DSH_COMFYUI_GATEWAY_ENV_FILE||join(root,".env");
if(process.env.DSH_COMFYUI_GATEWAY_ENV_FILE&&!existsSync(envFile))throw new Error("DSH_COMFYUI_GATEWAY_ENV_FILE does not exist");
if(existsSync(envFile))for(const line of readFileSync(envFile,"utf8").split(/\r?\n/)){
  const match=line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if(!match||env[match[1]]!==undefined)continue;
  let value=match[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  env[match[1]]=value;
}
const mode=process.argv[2]??"start";
let args;
if(mode==="start"){
  const port=env.GW_PORT??"8790";
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw new Error("GW_PORT must be 1..65535");
  args=["-m","uvicorn","app.main:app","--host","127.0.0.1","--port",port];
}else if(mode==="test")args=["-m","unittest","discover","-s","tests","-v"];
else if(mode==="check")args=["-c","import fastapi, uvicorn, httpx, jwt, PIL; from app.main import create_app; print('Gateway dependencies and app import: OK')"];
else throw new Error("Usage: gateway.mjs [start|test|check]");
const child=spawn(python,args,{cwd:root,env,stdio:"inherit"});
child.on("error",()=>{console.error("Gateway Pythonを起動できません。uv sync --project gateway を実行するかDSH_COMFYUI_PYTHONを指定してください。");process.exitCode=1;});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{if(signal==="SIGINT"&&process.stdin.isTTY)return;child.kill(signal);});
child.on("exit",(code,signal)=>{process.exitCode=code??(signal?1:0);});
