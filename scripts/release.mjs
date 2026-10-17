import {existsSync,readdirSync,readFileSync,mkdirSync,copyFileSync,lstatSync} from 'node:fs';
import {resolve,relative,join,dirname,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=['.gitignore','LICENSE','NOTICE','README.md','package.json','package-lock.json','cordis.patch.yml','gateway/.env.example','gateway/pyproject.toml','gateway/uv.lock','gateway/README.md','gateway/NOTICE'];
const trees=['lib','src','scripts','test','docs','config','gateway/app','gateway/tests'];
const skip=new Set(['__pycache__','node_modules','.venv','.DS_Store']);
for(const folder of trees){
  function visit(dir){for(const entry of readdirSync(join(root,dir),{withFileTypes:true})){
    if(skip.has(entry.name))continue;
    const name=join(dir,entry.name);
    if(entry.isSymbolicLink())throw new Error(`Symlink is not allowed: ${name}`);
    if(entry.isDirectory())visit(name);else files.push(name);
  }}visit(folder);
}
const rules=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
 ['jwt',/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{15,}/],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
 ['cloud-key',/\bAKIA[A-Z0-9]{16}\b/],
 ['personal-home',/\/(?:Users|home)\/[A-Za-z0-9][A-Za-z0-9_.-]*\//],
 ['windows-personal-path',/[A-Z]:\\(?:Users|AI)\\/i],
];
const denyFile=process.env.DSH_COMFYUI_RELEASE_DENY_FILE;
const denied=denyFile?JSON.parse(readFileSync(denyFile,'utf8')):[];
if(!Array.isArray(denied)||denied.some(x=>typeof x!=='string'||!x))throw new Error('Deny file must be a nonempty-string JSON array');
const problems=[];
for(const name of files){
 if(lstatSync(join(root,name)).isSymbolicLink())throw new Error(`Symlink is not allowed: ${name}`);
 const text=readFileSync(join(root,name),'utf8');
 for(const [rule,pattern] of rules)if(pattern.test(text))problems.push({file:name,rule});
 if(denied.some(value=>text.toLowerCase().includes(value.toLowerCase())))problems.push({file:name,rule:'local-deny-list'});
 if(/(?:^|\/)(?:\.env(?:\..+)?|.*\.pem|.*\.key|credentials.*\.json|.*tokens.*\.json)$/.test(name)&&name!=='gateway/.env.example')problems.push({file:name,rule:'private-filename'});
}
if(problems.length){console.error(JSON.stringify({ok:false,problems},null,2));process.exit(1);}
const mode=process.argv[2]??'check';
if(mode==='export'){
 const destination=process.argv[3];if(!destination)throw new Error('Usage: npm run release:export -- /absolute/destination');
 const target=resolve(destination),rel=relative(root,target);
 if(!rel||!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)))throw new Error('Export destination must be outside the source tree');
 if(existsSync(target))throw new Error('Export destination exists; refusing to overwrite');
 mkdirSync(target,{recursive:true});
 for(const name of files){const to=join(target,name);mkdirSync(dirname(to),{recursive:true});copyFileSync(join(root,name),to);}
 console.log(JSON.stringify({ok:true,files:files.length,destination:target,historyIncluded:false}));
}else if(mode==='check')console.log(JSON.stringify({ok:true,files:files.length,extraDenyList:Boolean(denyFile)}));
else throw new Error('Mode must be check or export');
