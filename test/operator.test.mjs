import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {apply as applyOperator} from "../lib/index.js";
import {apply as applyStudio} from "../lib/studio.js";
import {getRuntime,CONTEXT_TOOL,ACTION_TOOL} from "../lib/operator-runtime.js";
import {parseToolResult} from "../lib/studio-state.js";
import {assertArguments} from "../lib/input-validation.js";

const graph={"1":{class_type:"Valid",inputs:{steps:4,seed:0}}};
function setup(t){
  const dataDir=mkdtempSync(join(tmpdir(),"operator-review-"));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const hooks=new Map(),definitions=new Map(),guards=[],calls=[],names=new Set(["original"]);let route,fail=false,invalid=false;
  const raw=data=>({isError:false,value:{content:[{type:"text",text:JSON.stringify(data)}]},content:[{type:"text",text:JSON.stringify(data)}]});
  const agent={id:"session-operator-test",operator:true,ctx:{tools:null}};
  const tools={
    register:tool=>{definitions.set(tool.name,tool);},
    get:(name,subject)=>definitions.has(name)?(subject?.operator?definitions.get(name):undefined):name.startsWith("mcp__comfyui__")?{name}:undefined,
    schemas:subject=>["mcp__comfyui__comfy_status","mcp__comfyui__generate_image","mcp__comfyui__run_workflow","mcp__comfyui__save_workflow","read_file",...(subject.operator?[...definitions.keys()]:[])].map(name=>({name})),
    restrict:filter=>{agent.allowed=filter.allow;},guard:callback=>guards.push(callback),
    execute:async input=>{
      const exec={signal:new AbortController().signal,...input};
      try{
        for(const guard of guards){const denial=guard(exec);if(denial)throw new Error(denial);}
        const body=async()=>{
          const definition=tools.get(exec.name,exec.agent);
          if(!definition)throw new Error("unknown tool");
          if(definition.execute){const value=await definition.execute(exec.arguments,exec);assert.deepEqual(JSON.parse(JSON.stringify(value)),value,"Host outputs must be lossless JSON");return {isError:false,value,content:definition.output.render(exec.arguments,value)};}
          const tool=exec.name.split("__").at(-1);calls.push({tool,args:structuredClone(exec.arguments)});
          if(tool==="node_info")return raw({Valid:{inputs:{steps:{kind:"value",type:"INT",min:1,max:50},seed:{kind:"value",type:"INT",min:0}}}});
          if(tool==="validate_workflow")return raw({errors:invalid?["unknown node"]:[],warnings:[]});
          if(tool==="list_workflows")return raw({workflows:[...names].map(name=>({name}))});
          if(tool==="get_workflow")return raw({name:exec.arguments.name,workflow:graph});
          if(tool==="save_workflow"){names.add(exec.arguments.name);return raw({saved:exec.arguments.name});}
          if(tool==="generate_image"||tool==="run_workflow"){
            if(fail==="unknown")return raw({job_id:"test-job",status:"unknown",status_error:"history/queue race"});
            if(fail)throw new Error("no such job after submit");
            return raw({job_id:"test-job",status:"queued"});
          }
          if(tool==="get_job")return raw({job_id:exec.arguments.job_id,status:"running"});
          return raw({ok:true});
        };
        const listeners=hooks.get("tools/execute")??[];
        const dispatch=index=>index<listeners.length?listeners[index](exec,()=>dispatch(index+1)):body();
        const result=await dispatch(0);
        for(const listener of hooks.get("tools/result")??[])listener(exec,result);
        return result;
      }catch(error){return {isError:true,error:{message:error.message},content:[{type:"text",text:error.message}]};}
    },
  };agent.ctx.tools=tools;
  const ctx={tools,agents:{get:id=>id===agent.id?agent:undefined},connection:{fetch:{register:value=>{route=value;}}},logger:{warn:()=>{}},on:(name,callback)=>{const list=hooks.get(name)??[];list.push(callback);hooks.set(name,list);}};
  applyStudio(ctx,{dataDir});applyOperator(ctx,{dataDir});
  const invoke=async(name,args,subject=agent)=>tools.execute({agent:subject,name,arguments:args,callId:`test-${Math.random()}`});
  const context=async()=>parseToolResult(await invoke(CONTEXT_TOOL,{})).data;
  const action=(requestId,tool,args,overwrite=false)=>invoke(ACTION_TOOL,{requestId,tool,arguments:args,overwrite});
  return {agent,ctx,hooks,calls,names,context,action,invoke,runtime:getRuntime(dataDir),setFail:value=>{fail=value;},setInvalid:value=>{invalid=value;},route:()=>route};
}

test("Operator membership excludes other presets using the same MCP namespace",async t=>{
  const s=setup(t);for(const listener of s.hooks.get("agent/created"))listener({agent:s.agent});
  assert.ok(s.agent.allowed.includes(CONTEXT_TOOL));assert.ok(!s.agent.allowed.includes("read_file"));
  let restricted=false;const other={id:"session-other-preset",operator:false,ctx:{tools:{...s.ctx.tools,restrict:()=>{restricted=true;}}}};
  for(const listener of s.hooks.get("agent/created"))listener({agent:other});
  assert.equal(restricted,false);
});
test("Agent mutations require the protected action and reuse IDs without repeating GPU work",async t=>{
  const s=setup(t);
  assert.equal((await s.invoke("mcp__comfyui__generate_image",{prompt:"safe sample"})).isError,true);
  assert.equal(s.calls.filter(c=>c.tool==="generate_image").length,0);
  const {nextRequestId}=await s.context();
  assert.equal((await s.action(nextRequestId,"generate_image",{prompt:"safe sample"})).isError,false);
  assert.equal((await s.action(nextRequestId,"generate_image",{prompt:"safe sample"})).isError,false);
  assert.equal(s.calls.filter(c=>c.tool==="generate_image").length,1);
});
test("uncertain Agent submissions block different IDs and panel attempts until user reconciliation",async t=>{
  const s=setup(t),{nextRequestId}=await s.context();s.setFail(true);
  assert.equal((await s.action(nextRequestId,"generate_image",{prompt:"safe sample"})).isError,true);
  const next=await s.context();assert.equal(next.uncertainRequests.length,1);
  assert.equal((await s.action(next.nextRequestId,"generate_image",{prompt:"safe sample"})).isError,true);
  await assert.rejects(s.runtime.execute({agent:s.agent,name:"mcp__comfyui__run_workflow",arguments:{workflow:graph},callId:"panel-test"},async()=>{throw new Error("must not dispatch");},{requestId:`${Date.now()}-panel-attempt`,origin:"panel"}),/送信結果が不明/);
  assert.equal(s.calls.filter(c=>c.tool==="generate_image").length,1);
  s.runtime.acknowledge(s.agent.id,nextRequestId);s.setFail(false);
  assert.equal((await s.action((await s.context()).nextRequestId,"generate_image",{prompt:"new requested sample"})).isError,false);
  assert.equal((await s.action(nextRequestId,"generate_image",{prompt:"safe sample"})).isError,true);
});
test("save and edit-save cannot bypass collisions or graph validation; authorized overwrite succeeds",async t=>{
  const s=setup(t);
  assert.equal((await s.action((await s.context()).nextRequestId,"save_workflow",{name:"original",workflow:graph})).isError,true);
  assert.equal(s.calls.filter(c=>c.tool==="save_workflow").length,0);
  for(const name of ["original.json","original ","ORIGINAL","original.json.json","original.json "])assert.equal((await s.action((await s.context()).nextRequestId,"save_workflow",{name,workflow:graph})).isError,true);
  assert.equal(s.calls.filter(c=>c.tool==="save_workflow").length,0);
  assert.equal((await s.invoke("mcp__comfyui__edit_workflow",{name:"original",operations:[{op:"set_input"}],save_as:"original"})).isError,true);
  assert.equal(s.calls.filter(c=>c.tool==="edit_workflow").length,0);
  assert.equal((await s.action((await s.context()).nextRequestId,"save_workflow",{name:"original",workflow:graph},true)).isError,false);
  s.setInvalid(true);
  assert.equal((await s.action((await s.context()).nextRequestId,"save_workflow",{name:"new",workflow:graph},true)).isError,true);
  assert.equal(s.calls.filter(c=>c.tool==="save_workflow").length,1);
});
test("new Gateway overwrite is determined by protected action rather than raw model arguments",async t=>{
  const s=setup(t), get=s.ctx.tools.get;
  s.ctx.tools.get=(name,agent)=>name==="mcp__comfyui__save_workflow"?{name,parameters:{type:"object",properties:{name:{type:"string"},workflow:{type:"object"},overwrite:{type:"boolean"}}}}:get(name,agent);
  assert.equal((await s.action((await s.context()).nextRequestId,"save_workflow",{name:"new-name",workflow:graph,overwrite:true})).isError,false);
  assert.equal(s.calls.filter(c=>c.tool==="save_workflow").at(-1).args.overwrite,false);
  assert.equal((await s.action((await s.context()).nextRequestId,"save_workflow",{name:"original",workflow:graph},true)).isError,false);
  assert.equal(s.calls.filter(c=>c.tool==="save_workflow").at(-1).args.overwrite,true);
});
test("obvious argument mistakes do not create uncertain submissions or block corrections",async t=>{
  const s=setup(t);
  for(const args of [{prompt:""},{prompt:"   "},{prompt:"test",width:0}])assert.equal((await s.action((await s.context()).nextRequestId,"generate_image",args)).isError,true);
  assert.equal((await s.action((await s.context()).nextRequestId,"import_image",{image:""})).isError,true);
  assert.equal((await s.context()).uncertainRequests.length,0);
  assert.equal((await s.action((await s.context()).nextRequestId,"generate_image",{prompt:"corrected"})).isError,false);
  assert.equal((await s.invoke("mcp__comfyui__import_image",{image:"https://example.com/test.png"})).isError,true);
});
test("upstream required fields, types, bounds, enum and list sizes are checked before dispatch",()=>{
  const schema={type:"object",required:["images","steps","mode"],additionalProperties:false,properties:{images:{type:"array",minItems:1,maxItems:2,items:{type:"string"}},steps:{type:"integer",minimum:1,maximum:50},mode:{type:"string",enum:["safe"]}}};
  const good={images:["uploaded.png"],steps:4,mode:"safe"};assert.doesNotThrow(()=>assertArguments(schema,good));
  for(const value of [{...good,steps:0},{...good,steps:"4"},{...good,images:[]},{...good,images:[1]},{...good,mode:"unknown"},{...good,extra:true},{}])assert.throws(()=>assertArguments(schema,value));
});
test("named workflow input overrides are validated and the exact resolved graph is submitted",async t=>{
  const s=setup(t);
  assert.equal((await s.action((await s.context()).nextRequestId,"run_workflow",{name:"original",inputs:{"1.steps":0}})).isError,true);
  assert.equal(s.calls.filter(c=>c.tool==="run_workflow").length,0);
  assert.equal((await s.action((await s.context()).nextRequestId,"run_workflow",{name:"original",inputs:{"1.steps":5}})).isError,false);
  const args=s.calls.find(c=>c.tool==="run_workflow").args;
  assert.equal(args.workflow["1"].inputs.steps,5);assert.equal(args.inputs,undefined);
});
test("only explicitly shared drafts reach the context tool, with immutable revision metadata",async t=>{
  const s=setup(t);assert.equal((await s.context()).sharedDraft,null);
  const state=s.runtime.store.read(s.agent.id);state.jobs.push({job_id:"legacy-job",status:"done",previews:[]});state.requests["old-request"]={status:"pending",tool:"run_workflow",at:Date.now()};
  assert.equal((await s.context()).jobs[0].workflowName,null);
  const draft=structuredClone(graph);s.runtime.shareDraft(s.agent.id,{name:"browser draft",workflow:draft});draft["1"].inputs.seed=999;
  assert.equal((await s.context()).sharedDraft.workflow,undefined);
  const result=parseToolResult(await s.invoke(CONTEXT_TOOL,{includeDraft:true})).data;
  assert.equal(result.sharedDraft.workflow["1"].inputs.seed,0);assert.ok(result.sharedDraft.revision);
});
test("two model-facing errors stop the turn even with intervening reads; a fresh turn can recover",async t=>{
  const s=setup(t),observe=s.hooks.get("tools/result")[0],before=s.hooks.get("agent/pre-step")[0];
  observe({agent:s.agent,name:CONTEXT_TOOL,callId:"model-call-1"},{isError:true});
  observe({agent:s.agent,name:CONTEXT_TOOL,callId:"model-read-ok"},{isError:false});
  observe({agent:s.agent,name:CONTEXT_TOOL,callId:"model-call-2"},{isError:true});
  assert.equal((await before({agent:s.agent,step:3},async()=>({kind:"enter"}))).kind,"reject");
  assert.equal((await before({agent:s.agent,step:1},async()=>({kind:"enter"}))).kind,"enter");
});
test("Agent polling stops at six reads and resets at a new turn without limiting panel reads",async t=>{
  const s=setup(t);for(let i=0;i<6;i++)assert.equal((await s.invoke("mcp__comfyui__get_job",{job_id:"test-job"})).isError,false);
  assert.equal((await s.invoke("mcp__comfyui__get_job",{job_id:"test-job"})).isError,true);
  assert.equal((await s.runtime.policy.run({panel:true},()=>s.invoke("mcp__comfyui__get_job",{job_id:"test-job"}))).isError,false);
  await s.hooks.get("agent/pre-step")[0]({agent:s.agent,step:1},async()=>({kind:"allow"}));
  assert.equal((await s.invoke("mcp__comfyui__get_job",{job_id:"test-job"})).isError,false);
});

test("Gateway unknown receipts are reconciled by job ID without resubmitting",async t=>{
  const s=setup(t),{nextRequestId}=await s.context();s.setFail("unknown");
  assert.equal((await s.action(nextRequestId,"generate_image",{prompt:"safe sample"})).isError,true);
  assert.equal((await s.context()).uncertainRequests[0].job_id,"test-job");
  s.runtime.store.capture(s.agent.id,"get_job",{job_id:"test-job"},{isError:false,value:{content:[{type:"text",text:JSON.stringify({job_id:"test-job",status:"done"})}]}},"panel");
  assert.equal((await s.context()).uncertainRequests.length,0);
  assert.equal((await s.action(nextRequestId,"generate_image",{prompt:"safe sample"})).isError,false);
  assert.equal(s.calls.filter(call=>call.tool==="generate_image").length,1);
});
