import {readConnection,saveConnection} from "../lib/connection-config.js";
const args=process.argv.slice(2),values={};
const flags={"--url":"mcpUrl","--auth-dir":"authDir","--node":"nodeCommand"};
for(let i=0;i<args.length;i+=2){if(!flags[args[i]]||!args[i+1])throw new Error("Usage: npm run connection -- [--url URL] [--auth-dir PATH] [--node PATH]");values[flags[args[i]]]=args[i+1];}
if(args.length)saveConnection(values);
const config=readConnection();
console.log(JSON.stringify({mcpUrl:config.mcpUrl,authDir:config.authDir,configFile:config.file},null,2));
