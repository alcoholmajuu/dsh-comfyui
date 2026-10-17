import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioStore, ActionQueue, parseToolResult } from "../lib/studio-state.js";
import { changeInput, removeNode, addNode, graphLayout, assertGraph } from "../lib/graph.js";
import { apply } from "../lib/studio.js";
import { quickParameters, parameterKey, checkInputValues } from "../lib/parameters.js";
import { LIMITS, pruneState } from "../lib/retention.js";
import { zoomAt, fitGraph } from "../lib/viewport.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "comfy-studio-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new StudioStore(dir);
}
const session = "session-test-one";
const result = (data, images = []) => ({ value: { content: [{ type: "text", text: JSON.stringify(data) }, ...images] } });

test("concurrent and repeated submissions execute once, including after a restart", async t => {
  const store = fixture(t), queue = new ActionQueue(store); let calls = 0;
  const run = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { job_id: "real-job" }; };
  const args = { workflow: { "1": { class_type: "X", inputs: {} } } };
  const values = await Promise.all([queue.once(session,"request-1234","run_workflow",args,run),queue.once(session,"request-1234","run_workflow",args,run)]);
  assert.equal(calls, 1); assert.deepEqual(values[0], values[1]);
  const recovered = new ActionQueue(new StudioStore(store.root));
  assert.deepEqual(await recovered.once(session,"request-1234","run_workflow",args,run), values[0]);
  assert.equal(calls, 1);
  await assert.rejects(recovered.once(session,"request-1234","run_workflow",{...args,other:true},run), /different inputs/);
});
test("uncertain submissions survive restart and cannot silently be resubmitted", async t => {
  const store = fixture(t), queue = new ActionQueue(store); let calls = 0;
  await assert.rejects(queue.once(session,"request-uncertain","run_workflow",{},async()=>{calls++;throw new Error("connection dropped after submit");}));
  const recovered = new ActionQueue(new StudioStore(store.root));
  await assert.rejects(recovered.once(session,"request-uncertain","run_workflow",{},async()=>{calls++;}),/may have been submitted/);
  assert.equal(calls,1); assert.equal(store.snapshot(session).uncertainRequests.length,1);
});
test("queued request identities reject changed inputs before submission and survive cache eviction", async t => {
  const store=fixture(t),queue=new ActionQueue(store);let unblock;
  const gate=new Promise(resolve=>{unblock=resolve;});
  const pending=queue.once(session,"queued-request","run_workflow",{seed:1},async()=>({job_id:"correct-job"}),()=>gate);
  await assert.rejects(queue.once(session,"queued-request","run_workflow",{seed:2},async()=>({job_id:"wrong-job"})),/different inputs/);
  for(let i=0;i<25;i++) store.snapshot(`session-cache-${i}`);
  assert.ok(store.cache.size<=16);assert.equal(store.cache.has(session),true);
  unblock();await pending;
  assert.equal(new StudioStore(store.root).read(session).requests["queued-request"].value.job_id,"correct-job");
});
test("previews are scoped to their Session and persist with job updates", t => {
  const store=fixture(t), image={type:"image",mimeType:"image/png",data:Buffer.from("test bytes").toString("base64")};
  store.capture(session,"get_job",{},result({job_id:"job-1",status:"done"},[image]));
  const id=store.snapshot(session).jobs[0].previews[0].id;
  assert.match(store.asset(session,id),/^data:image\/png;base64,/);
  assert.throws(()=>store.asset("session-other",id),/does not belong/);
  assert.throws(()=>store.asset(session,"../../secret"),/Invalid image/);
  assert.throws(()=>store.read("../secret"),/Invalid Session/);
  store.capture(session,"get_job",{},result({job_id:"job-1",status:"done"}));
  assert.equal(store.snapshot(session).jobs[0].previews[0].id,id);
  assert.equal(new StudioStore(store.root).snapshot(session).jobs.length,1);
  assert.throws(()=>parseToolResult({isError:true,content:[{type:"text",text:"no such job"}]}),/no such job/);
});
test("node removal removes dangling links; edits preserve original graphs", () => {
  const graph={"1":{class_type:"Source",inputs:{seed:42}},"2":{class_type:"Sink",inputs:{image:["1",0],other:"retained"}}};
  const changed=changeInput(graph,"1","seed",7);assert.equal(graph["1"].inputs.seed,42);assert.equal(changed["1"].inputs.seed,7);
  const removed=removeNode(graph,"1");assert.equal(removed["2"].inputs.image,undefined);assert.equal(removed["2"].inputs.other,"retained");
  const added=addNode(graph,"New",{inputs:{flag:{kind:"value",type:"BOOLEAN",required:true},model:{kind:"value",options:["installed"]},latent:{kind:"link"}}});
  assert.equal(added.id,"3");assert.deepEqual(added.graph["3"].inputs,{flag:false,model:"installed"});
  assert.equal(graphLayout(graph).edges.length,1);
  assert.doesNotThrow(()=>graphLayout({"1":{class_type:"Cycle",inputs:{self:["1",0]}}}));
  assert.throws(()=>assertGraph({nodes:[]}),/形式/);
});

test("quick parameters support custom nodes, pins and seed zero without exposing links", () => {
  const graph={"1":{class_type:"NewCustom",inputs:{prompt:"scene",seed:0,strength:0.7,model:["2",0]}},"2":{class_type:"Loader",inputs:{path:"model.safetensors"}}};
  const pins=[parameterKey("1","strength"),parameterKey("1","model"),parameterKey("gone","stale")];
  const params=quickParameters(graph,{},pins);
  assert.deepEqual(params.map(p=>p.input),["prompt","seed","strength"]);
  assert.equal(params.find(p=>p.input==="seed").value,0);
  assert.equal(params.find(p=>p.input==="strength").pinned,true);
  assert.equal(quickParameters(graph,{NewCustom:{inputs:{prompt:{kind:"link"}}}},pins).some(p=>p.input==="prompt"),false);
});

test("scalar preflight rejects wrong types and bounds without rejecting partial combo lists", () => {
  const definitions={Custom:{inputs:{steps:{type:"INT",kind:"value",min:1,max:50},cfg:{type:"FLOAT",min:0,max:20},seed:{type:"INT",min:0},enabled:{type:"BOOLEAN"},text:{type:"STRING"},model:{options:["first"],options_total:100}}}};
  const graph={"1":{class_type:"Custom",inputs:{steps:4,cfg:0.5,enabled:false,text:"",model:"not-in-preview"}}};
  assert.deepEqual(checkInputValues(graph,definitions),[]);
  for(const value of ["4",4.5,0,51]) assert.equal(checkInputValues(changeInput(graph,"1","steps",value),definitions).length,1);
  assert.equal(checkInputValues(changeInput(graph,"1","enabled","false"),definitions).length,1);
  assert.equal(checkInputValues(changeInput(graph,"1","text",123),definitions).length,1);
  assert.deepEqual(checkInputValues(changeInput(graph,"1","seed",-1),definitions),[]);
});

test("submitted workflows survive polling and restart as independent execution snapshots", t => {
  const store=fixture(t), graph={"1":{class_type:"Custom",inputs:{seed:0,prompt:"original"}}};
  store.capture(session,"run_workflow",{workflow:graph,name:"demo"},result({job_id:"snapshot-job",status:"queued"}));
  graph["1"].inputs.prompt="changed later";
  store.capture(session,"get_job",{},result({job_id:"snapshot-job",status:"done"}));
  const job=new StudioStore(store.root).snapshot(session).jobs[0];
  assert.equal(job.submittedWorkflow.workflow["1"].inputs.prompt,"original");
  assert.equal(job.submittedWorkflow.workflow["1"].inputs.seed,0);
  assert.equal(job.submittedWorkflow.name,"demo");
  store.capture(session,"run_workflow",{workflow:graph,inputs:{"1.prompt":"override","1.seed":-1}},result({job_id:"random-job",seeds:{"1.seed":12345}}));
  const replay=new StudioStore(store.root).snapshot(session).jobs[0].submittedWorkflow.workflow;
  assert.equal(replay["1"].inputs.seed,12345);
  assert.equal(replay["1"].inputs.prompt,"override");
});

test("graph zoom remains anchored under the cursor and fit uses available space", () => {
  const before={x:12,y:-20,scale:0.8},point={x:125,y:75},after=zoomAt(before,1.6,point);
  assert.equal((point.x-before.x)/before.scale,(point.x-after.x)/after.scale);
  assert.equal((point.y-before.y)/before.scale,(point.y-after.y)/after.scale);
  assert.equal(zoomAt(before,100,point).scale,3);
  assert.equal(zoomAt(before,0,point).scale,0.15);
  const fitted=fitGraph({width:1000,height:500},600,320);
  assert.ok(fitted.scale<1);assert.ok(fitted.x>=16);assert.ok(fitted.y>=16);
  const tall=fitGraph({width:400,height:41014},600,320);
  assert.ok(tall.scale<0.15);assert.ok(41014*tall.scale<=288);
});

test("retention removes stale images, caps activity, and suppresses unchanged job polls", t => {
  const store=fixture(t), first={type:"image",mimeType:"image/png",data:Buffer.from("first image").toString("base64")};
  store.capture(session,"get_job",{},result({job_id:"job-0",status:"done"},[first]),"panel");
  const oldId=store.snapshot(session).jobs[0].previews[0].id;
  for(let i=0;i<100;i++) store.capture(session,"get_job",{},result({job_id:"job-0",status:"done"}),"panel");
  assert.equal(store.snapshot(session).activity.length,1);
  for(let i=1;i<=90;i++) store.capture(session,"get_job",{},result({job_id:`job-${i}`,status:"done"}),"agent");
  assert.equal(store.snapshot(session).jobs.length,LIMITS.jobs);
  assert.equal(store.snapshot(session).activity.length,LIMITS.activity);
  assert.equal(existsSync(join(store.path(session),"images",oldId)),false);
  assert.equal(readdirSync(join(store.path(session),"images")).length,0);
});

test("preview capacity and active job retention are bounded", () => {
  const state={jobs:[{job_id:"active",status:"running",previews:[]},...Array.from({length:70},(_,i)=>({job_id:String(i),status:"done",previews:[{id:String(i),bytes:64*1024*1024}]}))],activity:[],requests:{}};
  pruneState(state);
  assert.equal(state.jobs.length,60);assert.equal(state.jobs[0].job_id,"active");
  assert.equal(state.jobs.flatMap(j=>j.previews).length,2);
  assert.equal(state.jobs[3].previewsExpired,true);
});

test("expired request results cannot be resubmitted after pruning or restart", async t => {
  const store=fixture(t),queue=new ActionQueue(store);let calls=0;
  const run=async()=>{calls++;return {job_id:"retained"};};
  const stamp=Date.now()-1000,old=`${stamp}-old-request`,latest=`${stamp+LIMITS.requests+1}-latest-request`;
  await queue.once(session,old,"run_workflow",{},run);
  const state=store.read(session);
  for(let i=1;i<=LIMITS.requests+1;i++) state.requests[`${stamp+i}-result`]={status:"done",tool:"run_workflow",at:Date.now()+i,value:{}};
  store.write(session);
  assert.ok(Object.keys(state.requests).length<=LIMITS.requests);
  const restarted=new ActionQueue(new StudioStore(store.root));
  await assert.rejects(restarted.once(session,old,"run_workflow",{},run),/保持期限/);assert.equal(calls,1);
  await restarted.once(session,latest,"run_workflow",{},run);assert.equal(calls,2);
});

test("uncertain requests are preserved and stop new submissions at capacity", async t => {
  const store=fixture(t),state=store.read(session);
  for(let i=0;i<LIMITS.pending;i++) state.requests[`uncertain-${i}`]={status:"pending",at:1,tool:"run_workflow",fingerprint:"unknown"};
  store.write(session);assert.equal(store.snapshot(session).uncertainRequests.length,LIMITS.pending);
  let called=false;
  await assert.rejects(new ActionQueue(store).once(session,`${Date.now()}-new-request`,"run_workflow",{},async()=>{called=true;}),/新規送信を停止/);
  assert.equal(called,false);assert.equal(new StudioStore(store.root).snapshot(session).uncertainRequests.length,LIMITS.pending);
});

test("panel API restricts the Session and tool surface, validates graphs, and serializes save conflicts", async t => {
  const store=fixture(t); let route, observer; const calls=[];
  const agent={id:session,ctx:{tools:{get:name=>name==="comfyui_operator_context"?{comfyuiOperator:true}:name.startsWith("mcp__comfyui__"),execute:async exec=>{
    calls.push(exec.name);
    const tool=exec.name.split("__").at(-1);
    const data=tool==="node_info"?{Valid:{inputs:{steps:{kind:"value",type:"INT",min:1,max:50}}}}:tool==="validate_workflow"?{errors:exec.arguments.workflow["1"].class_type==="Invalid"?["unknown node"]:[]}:tool==="list_workflows"?{workflows:[{name:"existing"}]}:{job_id:"job-from-api",status:"queued"};
    const out=result(data);observer(exec,out);return out;
  }}}};
  let cold=false;
  const ctx={agents:{get:id=>id===session&&!cold?agent:undefined},sessionController:{resolveAgent:async id=>id===session?{agent}:{error:new Error("missing Session")}},connection:{fetch:{register:r=>{route=r;}}},on:(event,callback)=>{observer=callback;},logger:{warn:()=>{}}};
  apply(ctx,{dataDir:store.root});
  const invoke=async payload=>(await route.fetch(new Request("http://dsh.internal/api/comfyui-studio",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"test-rpc",method:"comfyui-studio",payload})}))).json();
  assert.equal((await invoke({sessionId:"session-other",action:"snapshot"})).result.ok,false);
  assert.equal((await invoke({sessionId:session,action:"call",tool:"delete_workflow",args:{name:"existing"}})).result.ok,false);
  const graph={"1":{class_type:"Valid",inputs:{}}};
  const request={sessionId:session,action:"call",tool:"run_workflow",args:{workflow:graph},requestId:"api-run-1234"};
  assert.equal((await invoke(request)).result.value.job_id,"job-from-api");
  await invoke(request);assert.equal(calls.filter(n=>n.endsWith("__run_workflow")).length,1);
  const bad=await invoke({...request,args:{workflow:{"1":{class_type:"Invalid",inputs:{}}}},requestId:"api-run-invalid"});
  assert.equal(bad.result.ok,false);assert.equal(calls.filter(n=>n.endsWith("__run_workflow")).length,1);
  const wrongNumber=await invoke({...request,args:{workflow:changeInput(graph,"1","steps",0)},requestId:"api-run-out-of-range"});
  assert.equal(wrongNumber.result.ok,false);assert.match(wrongNumber.result.error.message,/範囲外/);
  assert.equal(calls.filter(n=>n.endsWith("__run_workflow")).length,1);
  const save=await invoke({...request,tool:"save_workflow",args:{name:"existing",workflow:graph},requestId:"api-save-conflict"});
  assert.equal(save.result.ok,false);assert.match(save.result.error.message,/同名/);
  assert.equal(new StudioStore(store.root).snapshot(session).uncertainRequests.length,0);
  const snapshot=await invoke({sessionId:session,action:"snapshot"});assert.equal(snapshot.result.value.jobs.length,1);
  cold=true;
  assert.equal((await invoke({sessionId:session,action:"snapshot"})).result.value.jobs.length,1);
});
