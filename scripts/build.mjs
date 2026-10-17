import { build } from "esbuild";
import { writeFileSync } from "node:fs";
const { outputFiles } = await build({ entryPoints: ["src/client.jsx"], bundle: true, write: false, format: "cjs", platform: "browser", target: "chrome130", external: ["react"], jsx: "transform", logLevel: "warning" });
writeFileSync("lib/client.js", `window.__ModuleLoader__.load({id:"@local/dsh-comfyui",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${outputFiles[0].text}\nreturn module.exports;}});\n`);
