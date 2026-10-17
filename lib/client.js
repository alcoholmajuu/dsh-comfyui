window.__ModuleLoader__.load({id:"@local/dsh-comfyui",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = __toESM(require("react"), 1);

// lib/graph.js
function assertGraph(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.keys(graph).length) throw new Error("API\u5F62\u5F0F\u306E\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  if (Object.keys(graph).length > 500) throw new Error("\u3053\u306E\u30A8\u30C7\u30A3\u30BF\u30FC\u306F500\u30CE\u30FC\u30C9\u307E\u3067\u5BFE\u5FDC\u3057\u307E\u3059\u3002");
  for (const [id, node] of Object.entries(graph)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !node || typeof node.class_type !== "string" || !node.inputs || Array.isArray(node.inputs) || typeof node.inputs !== "object") throw new Error(`\u30CE\u30FC\u30C9 ${id} \u306E\u5F62\u5F0F\u304C\u4E0D\u6B63\u3067\u3059\u3002`);
  }
  return graph;
}
var isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
function changeInput(graph, id, input, value) {
  return { ...graph, [id]: { ...graph[id], inputs: { ...graph[id].inputs, [input]: value } } };
}
function removeNode(graph, id) {
  const next = structuredClone(graph);
  delete next[id];
  for (const node of Object.values(next)) for (const [key, value] of Object.entries(node.inputs)) if (isLink(value) && value[0] === id) delete node.inputs[key];
  return next;
}
function addNode(graph, type, definition) {
  let number = 1;
  while (graph[String(number)]) number++;
  const inputs = {};
  for (const [key, spec] of Object.entries(definition?.inputs ?? {})) {
    if (spec.kind === "link") continue;
    if (spec.default !== void 0) inputs[key] = spec.default;
    else if (spec.options?.length) inputs[key] = spec.options[0];
    else if (spec.required) inputs[key] = spec.type === "BOOLEAN" ? false : ["INT", "FLOAT"].includes(spec.type) ? spec.min ?? 0 : "";
  }
  return { graph: { ...graph, [number]: { class_type: type, inputs } }, id: String(number) };
}
function graphLayout(graph) {
  const ids = Object.keys(graph), depth = {}, visiting = /* @__PURE__ */ new Set();
  function visit(id) {
    if (depth[id] !== void 0) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = Object.values(graph[id]?.inputs ?? {}).filter(isLink).map((v) => v[0]).filter((p) => graph[p]);
    const d = parents.length ? Math.min(12, 1 + Math.max(...parents.map(visit))) : 0;
    visiting.delete(id);
    return depth[id] = d;
  }
  const rows = {}, nodes = ids.map((id) => {
    const col = visit(id), row = rows[col] ?? 0;
    rows[col] = row + 1;
    return { id, x: 20 + col * 210, y: 20 + row * 82 };
  });
  const positions = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = ids.flatMap((id) => Object.entries(graph[id].inputs).filter(([, v]) => isLink(v) && positions[v[0]]).map(([input, v]) => ({ from: positions[v[0]], to: positions[id], input, output: v[1] })));
  return { nodes, edges, width: Math.max(400, ...nodes.map((n) => n.x + 200)), height: Math.max(150, ...nodes.map((n) => n.y + 76)) };
}

// lib/parameters.js
var common = /* @__PURE__ */ new Set(["text", "prompt", "positive", "negative", "seed", "noise_seed", "steps", "cfg", "denoise", "width", "height", "batch_size"]);
var parameterKey = (nodeId, input) => JSON.stringify([nodeId, input]);
var scalar = (value) => ["string", "number", "boolean"].includes(typeof value);
function quickParameters(graph, definitions = {}, pinned = []) {
  const pins = new Set(pinned);
  return Object.entries(graph).flatMap(([nodeId, node]) => Object.entries(node.inputs).flatMap(([input, value]) => {
    const key = parameterKey(nodeId, input), spec = definitions[node.class_type]?.inputs?.[input];
    if (!scalar(value) || isLink(value) || spec?.kind === "link" || !common.has(input) && !pins.has(key)) return [];
    return [{ key, nodeId, input, value, spec, pinned: pins.has(key), title: node._meta?.title ?? node.class_type }];
  }));
}

// lib/viewport.js
var clampZoom = (scale, minimum = 0.15) => Math.min(3, Math.max(minimum, scale));
function zoomAt(view, scale, point, minimum) {
  const next = clampZoom(scale, minimum), ratio = next / view.scale;
  return { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
function fitGraph(layout, width, height) {
  const scale = Math.min(1, Math.max(1, width - 32) / layout.width, Math.max(1, height - 32) / layout.height);
  return { scale, x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 };
}

// src/client.jsx
var KIND = "comfyui-studio";
var ID = "@local/dsh-comfyui-oauth/studio";
var CSS = `
.comfy-studio{height:100%;overflow:auto;background:var(--surface,#141515);color:inherit;font:12px/1.55 system-ui,sans-serif;--cs-border:rgba(150,160,160,.2);--cs-dim:#999f9d;--cs-accent:#b9ddc8;--cs-card:rgba(130,145,138,.065)}
.comfy-studio *{box-sizing:border-box}.comfy-studio button,.comfy-studio input,.comfy-studio select,.comfy-studio textarea{font:inherit;color:inherit;border:1px solid var(--cs-border);border-radius:7px;background:transparent;padding:6px 9px;max-width:100%}.comfy-studio button{cursor:pointer;white-space:nowrap}.comfy-studio button:hover:not(:disabled){background:rgba(140,170,153,.12);border-color:#7b9a89}.comfy-studio button:disabled{opacity:.4;cursor:default}.comfy-studio input:not([type=checkbox]),.comfy-studio textarea,.comfy-studio select{width:100%;background:rgba(100,120,110,.045)}.comfy-studio select option{background:#252826;color:#eee}.comfy-studio textarea{resize:vertical;min-height:72px}.comfy-studio a{color:var(--cs-accent)}
.cs-head{padding:18px 16px 12px;border-bottom:1px solid var(--cs-border)}.cs-eyebrow{font-size:9px;letter-spacing:.2em;color:var(--cs-dim);text-transform:uppercase}.cs-title{font-size:20px;letter-spacing:-.7px;font-weight:600;margin:3px 0 10px}.cs-line{display:flex;align-items:center;justify-content:space-between;gap:8px}.cs-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.cs-dot{width:6px;height:6px;border-radius:50%;background:#9bd0af;display:inline-block;margin-right:7px}.cs-muted{color:var(--cs-dim);font-size:11px}.cs-tabs{display:flex;gap:15px;border-bottom:1px solid var(--cs-border);padding:0 16px;position:sticky;top:0;background:var(--surface,#141515);z-index:2}.cs-tabs button{border:0;border-radius:0;padding:10px 0;color:var(--cs-dim)}.cs-tabs button[aria-selected=true]{color:var(--cs-accent);box-shadow:inset 0 -2px var(--cs-accent)}.cs-body{padding:16px}.cs-card{border:1px solid var(--cs-border);border-radius:10px;background:var(--cs-card);padding:12px;margin-bottom:12px}.cs-label{font-size:10px;color:var(--cs-dim);display:block;margin-bottom:4px}.cs-empty{padding:35px 15px;text-align:center;color:var(--cs-dim)}.cs-empty b{display:block;font-size:15px;color:inherit;margin-bottom:6px}.cs-error{margin:12px 16px 0;padding:10px 12px;background:rgba(190,95,80,.12);border:1px solid rgba(200,110,95,.35);border-radius:8px;color:#e4b3a7;white-space:pre-wrap;overflow-wrap:anywhere}.cs-note{padding:9px 11px;border-left:2px solid #779a87;color:var(--cs-dim);font-size:11px;margin-bottom:12px}.cs-primary{background:var(--cs-accent)!important;color:#17251c!important;border-color:transparent!important;font-weight:600!important}.cs-badge{font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(150,170,150,.13);color:var(--cs-accent)}.cs-image{width:100%;max-height:350px;object-fit:contain;border-radius:7px;background:repeating-conic-gradient(#242725 0% 25%,#202320 0% 50%) 50%/14px 14px;cursor:zoom-in}.cs-job-id{font:10px ui-monospace,monospace;overflow-wrap:anywhere;color:var(--cs-dim)}.cs-field{margin-bottom:12px}.cs-field-title{display:flex;gap:6px;align-items:baseline;margin-bottom:4px}.cs-field-title strong{font-size:11px}.cs-field-title small{color:var(--cs-dim);font-size:9px}.cs-graph{overflow:hidden;position:relative;border:1px solid var(--cs-border);border-radius:8px;height:320px;min-height:180px;max-height:70vh;resize:vertical;background-color:rgba(80,110,90,.035);background-image:radial-gradient(rgba(140,170,150,.2) 1px,transparent 1px);background-size:18px 18px;margin:8px 0 12px;touch-action:none;user-select:none}.cs-graph:focus-visible{outline:2px solid var(--cs-accent);outline-offset:2px}.cs-graph svg{display:block}.cs-graph-tools{margin-top:12px}.cs-graph-tools button{padding:3px 7px}.comfy-studio fieldset{border:0;padding:0;margin:0;min-width:0}.cs-node-grid{display:grid;grid-template-columns:minmax(100px,.8fr) minmax(0,1.8fr);gap:10px}.cs-node-list{max-height:480px;overflow:auto}.cs-node-list button{display:block;width:100%;text-align:left;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis}.cs-node-list button[aria-pressed=true]{border-color:#8cae9b;background:rgba(150,185,160,.1)}.cs-node-id{font:10px ui-monospace,monospace;color:var(--cs-dim);margin-right:5px}.cs-toolbar{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.cs-result{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.cs-library{width:100%;text-align:left!important;display:block;margin-bottom:6px;padding:10px!important}.cs-library strong{display:block;font-weight:500}.cs-library span{display:block;color:var(--cs-dim);font-size:10px;white-space:normal}.cs-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.86);z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:25px}.cs-lightbox img{max-width:95vw;max-height:85vh;object-fit:contain}.cs-lightbox button{background:#222;color:#eee}.cs-check{display:flex;gap:7px;align-items:center;font-size:11px}.cs-code{font:10px/1.5 ui-monospace,monospace!important;min-height:200px!important}.cs-section{font-size:11px;font-weight:600;margin:16px 0 8px}.cs-activity{padding:8px 0;border-bottom:1px solid var(--cs-border)}
`;
var uuid = () => `${Date.now()}-${crypto.randomUUID()}`;
var pretty = (value) => JSON.stringify(value, null, 2);
var activeJob = (job) => ["queued", "running"].includes(job.status);
function Graph({ graph, selected, onSelect }) {
  const layout = graphLayout(graph), host = (0, import_react.useRef)(null), camera = (0, import_react.useRef)({ x: 0, y: 0, scale: 1 }), drag = (0, import_react.useRef)(null), layoutRef = (0, import_react.useRef)(layout);
  layoutRef.current = layout;
  const [view, setView] = (0, import_react.useState)(camera.current), [dragging, setDragging] = (0, import_react.useState)(false);
  function move(next) {
    camera.current = next;
    setView(next);
  }
  function fit() {
    const box = host.current?.getBoundingClientRect();
    if (box?.width) move(fitGraph(layout, box.width, box.height));
  }
  function zoom(factor, point) {
    const box = host.current.getBoundingClientRect();
    move(zoomAt(camera.current, camera.current.scale * factor, point ?? { x: box.width / 2, y: box.height / 2 }, Math.min(0.15, fitGraph(layoutRef.current, box.width, box.height).scale)));
  }
  const layoutKey = Object.entries(graph).map(([id, node]) => `${id}:${node.class_type}`).join("|");
  (0, import_react.useEffect)(() => {
    fit();
  }, [layoutKey]);
  (0, import_react.useEffect)(() => {
    const element = host.current;
    const wheel = (event) => {
      event.preventDefault();
      const box = element.getBoundingClientRect(), delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
      zoom(Math.exp(-Math.max(-200, Math.min(200, delta)) * 2e-3), { x: event.clientX - box.left, y: event.clientY - box.top });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  function pointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && event.target.closest("[data-node]")) return;
    event.preventDefault();
    host.current.focus();
    host.current.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view: camera.current };
    setDragging(true);
  }
  function pointerMove(event) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    move({ ...start.view, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y });
  }
  function pointerEnd(event) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (host.current.hasPointerCapture(event.pointerId)) host.current.releasePointerCapture(event.pointerId);
  }
  function keyboard(event) {
    if (event.target !== event.currentTarget) return;
    const directions = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
    if (directions[event.key]) {
      event.preventDefault();
      const [x, y] = directions[event.key];
      move({ ...camera.current, x: camera.current.x + x, y: camera.current.y + y });
    } else if (["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "0") fit();
      else zoom(event.key === "-" ? 1 / 1.2 : 1.2);
    }
  }
  return /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-row cs-graph-tools" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted" }, "\u30DB\u30A4\u30FC\u30EB\u3067\u62E1\u7E2E \xB7 \u7A7A\u767D\u3092\u30C9\u30E9\u30C3\u30B0\u3067\u79FB\u52D5"), /* @__PURE__ */ import_react.default.createElement("button", { "aria-label": "\u30B0\u30E9\u30D5\u3092\u7E2E\u5C0F", onClick: () => zoom(1 / 1.2) }, "\u2212"), /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted", "aria-live": "polite" }, view.scale < 0.01 ? (view.scale * 100).toFixed(1) : Math.round(view.scale * 100), "%"), /* @__PURE__ */ import_react.default.createElement("button", { "aria-label": "\u30B0\u30E9\u30D5\u3092\u62E1\u5927", onClick: () => zoom(1.2) }, "\uFF0B"), /* @__PURE__ */ import_react.default.createElement("button", { onClick: fit }, "\u5168\u4F53\u8868\u793A"), /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => {
    const box = host.current.getBoundingClientRect();
    move(zoomAt(camera.current, 1, { x: box.width / 2, y: box.height / 2 }));
  } }, "100%")), /* @__PURE__ */ import_react.default.createElement("div", { ref: host, className: "cs-graph", tabIndex: 0, role: "group", "aria-label": "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u306E\u63A5\u7D9A\u56F3\u3002\u77E2\u5370\u3067\u79FB\u52D5\u3001\u30D7\u30E9\u30B9\u30FB\u30DE\u30A4\u30CA\u30B9\u3067\u62E1\u7E2E\u30010\u3067\u5168\u4F53\u8868\u793A", style: { cursor: dragging ? "grabbing" : "grab" }, onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerEnd, onPointerCancel: pointerEnd, onLostPointerCapture: () => {
    drag.current = null;
    setDragging(false);
  }, onKeyDown: keyboard, onDoubleClick: (event) => {
    if (!event.target.closest("[data-node]")) fit();
  } }, /* @__PURE__ */ import_react.default.createElement("svg", { width: "100%", height: "100%", role: "img", "aria-label": `${layout.nodes.length}\u500B\u306E\u30CE\u30FC\u30C9\u3068${layout.edges.length}\u672C\u306E\u63A5\u7D9A` }, /* @__PURE__ */ import_react.default.createElement("g", { transform: `translate(${view.x} ${view.y}) scale(${view.scale})` }, layout.edges.map((edge, i) => /* @__PURE__ */ import_react.default.createElement("path", { key: i, d: `M${edge.from.x + 176},${edge.from.y + 29} C${edge.from.x + 200},${edge.from.y + 29} ${edge.to.x - 25},${edge.to.y + 29} ${edge.to.x},${edge.to.y + 29}`, fill: "none", stroke: "#658a76", opacity: ".65", strokeWidth: "1.5", pointerEvents: "none" })), layout.nodes.map((node) => /* @__PURE__ */ import_react.default.createElement("g", { key: node.id, "data-node": node.id, onClick: () => onSelect(node.id), role: "button", tabIndex: 0, onKeyDown: (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(node.id);
    }
  }, "aria-label": `\u30CE\u30FC\u30C9 ${node.id} ${graph[node.id].class_type}`, style: { cursor: "pointer" } }, /* @__PURE__ */ import_react.default.createElement("title", null, `#${node.id} ${graph[node.id]._meta?.title ?? graph[node.id].class_type}`), /* @__PURE__ */ import_react.default.createElement("rect", { x: node.x, y: node.y, width: "176", height: "58", rx: "7", fill: selected === node.id ? "#33483c" : "#222a25", stroke: selected === node.id ? "#b9ddc8" : "#48554c" }), /* @__PURE__ */ import_react.default.createElement("text", { x: node.x + 10, y: node.y + 20, fill: "#a2b1a7", fontSize: "10" }, "#", node.id), /* @__PURE__ */ import_react.default.createElement("text", { x: node.x + 10, y: node.y + 40, fill: "#e0e9e3", fontSize: "10" }, (graph[node.id]._meta?.title ?? graph[node.id].class_type).slice(0, 25))))))));
}
function Preview({ image, api }) {
  const [url, setUrl] = (0, import_react.useState)(""), [error, setError] = (0, import_react.useState)(""), [open, setOpen] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    let live = true;
    api({ action: "asset", id: image.id }).then((value) => {
      if (live) setUrl(value);
    }).catch((e) => {
      if (live) setError(e.message);
    });
    return () => {
      live = false;
    };
  }, [image.id, api]);
  if (error) return /* @__PURE__ */ import_react.default.createElement("p", { className: "cs-muted" }, "\u30D7\u30EC\u30D3\u30E5\u30FC\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093: ", error);
  if (!url) return /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-empty" }, "\u30D7\u30EC\u30D3\u30E5\u30FC\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026");
  return /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("img", { className: "cs-image", src: url, alt: "ComfyUI\u306E\u751F\u6210\u7D50\u679C\u30D7\u30EC\u30D3\u30E5\u30FC", onClick: () => setOpen(true) }), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-row", style: { marginTop: 6 } }, /* @__PURE__ */ import_react.default.createElement("a", { href: url, download: `comfy-preview-${image.id.slice(0, 10)}.${image.mimeType === "image/png" ? "png" : "jpg"}` }, "\u30D7\u30EC\u30D3\u30E5\u30FC\u3092\u4FDD\u5B58"), /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted" }, Math.round(image.bytes / 1024), " KB \xB7 \u539F\u5BF8\u3067\u306F\u3042\u308A\u307E\u305B\u3093")), open && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-lightbox", role: "dialog", "aria-modal": "true", "aria-label": "\u6210\u679C\u7269\u30D7\u30EC\u30D3\u30E5\u30FC", onClick: () => setOpen(false) }, /* @__PURE__ */ import_react.default.createElement("img", { src: url, alt: "\u6210\u679C\u7269\u306E\u62E1\u5927\u30D7\u30EC\u30D3\u30E5\u30FC" }), /* @__PURE__ */ import_react.default.createElement("button", { autoFocus: true, onClick: () => setOpen(false) }, "\u9589\u3058\u308B")));
}
function InputField({ input, value, spec, graph, definitions, update }) {
  const linked = isLink(value), linkType = spec?.kind === "link" || linked;
  if (linkType) {
    const options = Object.entries(graph).flatMap(([id, node]) => (definitions[node.class_type]?.outputs ?? []).filter((out) => !spec?.type || spec.type === "*" || out.type === spec.type).map((out) => ({ value: JSON.stringify([id, out.index]), label: `#${id} ${node._meta?.title ?? node.class_type} \u2192 ${out.name} [${out.type}]` })));
    const current = linked ? JSON.stringify(value) : "";
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-field" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-field-title" }, /* @__PURE__ */ import_react.default.createElement("strong", null, input), /* @__PURE__ */ import_react.default.createElement("small", null, spec?.type ?? "LINK", spec?.required ? " \xB7 \u5FC5\u9808" : "")), /* @__PURE__ */ import_react.default.createElement("select", { "aria-label": `${input} \u63A5\u7D9A\u5148`, value: current, onChange: (e) => update(e.target.value ? JSON.parse(e.target.value) : void 0) }, /* @__PURE__ */ import_react.default.createElement("option", { value: "" }, "\u672A\u63A5\u7D9A"), current && !options.some((o) => o.value === current) && /* @__PURE__ */ import_react.default.createElement("option", { value: current }, `#${value[0]} \u51FA\u529B${value[1]}`), options.map((o) => /* @__PURE__ */ import_react.default.createElement("option", { key: o.value, value: o.value }, o.label))), spec?.note && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, spec.note, " \xB7 \u7279\u6B8A\u5165\u529B\u306FJSON\u7DE8\u96C6\u3092\u4F7F\u7528\u3067\u304D\u307E\u3059\u3002"));
  }
  const type = spec?.type, numeric = ["INT", "FLOAT"].includes(type) || typeof value === "number";
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-field" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-field-title" }, /* @__PURE__ */ import_react.default.createElement("strong", null, input), /* @__PURE__ */ import_react.default.createElement("small", null, type ?? typeof value, spec?.required ? " \xB7 \u5FC5\u9808" : "")), type === "BOOLEAN" || typeof value === "boolean" ? /* @__PURE__ */ import_react.default.createElement("label", { className: "cs-check" }, /* @__PURE__ */ import_react.default.createElement("input", { type: "checkbox", checked: Boolean(value), onChange: (e) => update(e.target.checked) }), value ? "\u6709\u52B9" : "\u7121\u52B9") : spec?.options?.length ? /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("select", { "aria-label": input, value: String(value ?? ""), onChange: (e) => {
    const option = spec.options.find((o) => String(o) === e.target.value);
    update(option ?? e.target.value);
  } }, !spec.options.includes(value) && /* @__PURE__ */ import_react.default.createElement("option", { value: String(value ?? "") }, String(value ?? "\u672A\u8A2D\u5B9A")), spec.options.map((o, i) => /* @__PURE__ */ import_react.default.createElement("option", { key: i, value: String(o) }, String(o)))), spec.options_total > spec.options.length && /* @__PURE__ */ import_react.default.createElement("small", { className: "cs-muted" }, "\u5019\u88DC\u306E\u4E00\u90E8\u3092\u8868\u793A\u3002\u5168\u30E2\u30C7\u30EB\u306F\u30E2\u30C7\u30EB\u30BF\u30D6\u3067\u78BA\u8A8D\u3067\u304D\u307E\u3059\u3002")) : numeric ? /* @__PURE__ */ import_react.default.createElement("input", { "aria-label": input, type: "number", value: value ?? "", min: spec?.min, max: spec?.max, step: spec?.step ?? (type === "INT" ? 1 : "any"), onChange: (e) => {
    if (e.target.value !== "" && Number.isFinite(Number(e.target.value))) update(Number(e.target.value));
  } }) : typeof value === "object" && value !== null ? /* @__PURE__ */ import_react.default.createElement("textarea", { "aria-label": input, defaultValue: pretty(value), key: pretty(value), onBlur: (e) => {
    try {
      update(JSON.parse(e.target.value));
      e.target.setCustomValidity("");
    } catch {
      e.target.setCustomValidity("\u6B63\u3057\u3044JSON\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044");
      e.target.reportValidity();
    }
  } }) : /* @__PURE__ */ import_react.default.createElement("textarea", { "aria-label": input, rows: String(value ?? "").length > 100 ? 4 : 2, value: value ?? "", onChange: (e) => update(e.target.value) }), spec?.tooltip && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, spec.tooltip));
}
function Studio({ sessionId, connection, visible }) {
  const [tab, setTab] = (0, import_react.useState)("artifacts"), [snapshot, setSnapshot] = (0, import_react.useState)({ jobs: [], activity: [] }), [error, setError] = (0, import_react.useState)(""), [notice, setNotice] = (0, import_react.useState)(""), [busy, setBusy] = (0, import_react.useState)(false);
  const [library, setLibrary] = (0, import_react.useState)([]), [graph, setGraph] = (0, import_react.useState)(null), [name, setName] = (0, import_react.useState)(""), [description, setDescription] = (0, import_react.useState)(""), [dirty, setDirty] = (0, import_react.useState)(false), [selected, setSelected] = (0, import_react.useState)("");
  const [pinned, setPinned] = (0, import_react.useState)([]), [libraryQuery, setLibraryQuery] = (0, import_react.useState)("");
  const [definitions, setDefinitions] = (0, import_react.useState)({}), [report, setReport] = (0, import_react.useState)(null), [overwrite, setOverwrite] = (0, import_react.useState)(false), [query, setQuery] = (0, import_react.useState)(""), [hits, setHits] = (0, import_react.useState)([]), [models, setModels] = (0, import_react.useState)(null), [json, setJson] = (0, import_react.useState)(""), [showJson, setShowJson] = (0, import_react.useState)(false), [jobId, setJobId] = (0, import_react.useState)("");
  const pollIndex = (0, import_react.useRef)(0), history = (0, import_react.useRef)({ past: [], future: [] }), dirtyRef = (0, import_react.useRef)(false), revisionRef = (0, import_react.useRef)(0), busyRef = (0, import_react.useRef)(false), pendingRun = (0, import_react.useRef)(null), draftKey = `dsh.comfyui-studio.draft.${sessionId}`;
  const api = (0, import_react.useCallback)(async (payload) => {
    const result = await connection.rpc.call("/api", "comfyui-studio", { sessionId, ...payload });
    if (!result.ok) throw new Error(result.error?.message ?? "Studio API failed");
    return result.value;
  }, [sessionId, connection]);
  const call = (0, import_react.useCallback)((tool, args = {}, extra = {}) => api({ action: "call", tool, args, ...extra }), [api]);
  function markDirty(value) {
    dirtyRef.current = value;
    setDirty(value);
  }
  const refresh = (0, import_react.useCallback)(async () => {
    const state = await api({ action: "snapshot" });
    setSnapshot(state);
    setError((old) => old.startsWith("ComfyUI Operator") ? "" : old);
    return state;
  }, [api]);
  async function act(task) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await task();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  function change(next) {
    history.current.past.push(graph);
    history.current.past = history.current.past.slice(-40);
    history.current.future = [];
    setGraph(next);
    markDirty(true);
    setReport(null);
    pendingRun.current = null;
  }
  function moveHistory(direction) {
    const from = history.current[direction === "undo" ? "past" : "future"], to = history.current[direction === "undo" ? "future" : "past"];
    if (!from.length) return;
    to.push(graph);
    setGraph(from.pop());
    markDirty(true);
    setReport(null);
    pendingRun.current = null;
  }
  function adopt(record, unsaved = false) {
    assertGraph(record.workflow);
    setGraph(record.workflow);
    setPinned(Array.isArray(record.pinned) ? record.pinned : []);
    setName(record.name ?? "");
    setDescription(record.description ?? "");
    setSelected(Object.keys(record.workflow)[0] ?? "");
    markDirty(unsaved);
    setReport(null);
    setOverwrite(false);
    history.current = { past: [], future: [] };
    pendingRun.current = null;
  }
  function restoreJob(job) {
    if (dirtyRef.current) {
      setError("\u7DE8\u96C6\u4E2D\u306E\u4E0B\u66F8\u304D\u304C\u3042\u308A\u307E\u3059\u3002\u5148\u306B\u4FDD\u5B58\u30FBJSON\u66F8\u304D\u51FA\u3057\u3001\u307E\u305F\u306F\u300C\u4E0B\u66F8\u304D\u3092\u7834\u68C4\u300D\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002");
      return;
    }
    adopt(job.submittedWorkflow, true);
    setTab("workflow");
    setNotice("\u5B9F\u884C\u6642\u306E\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u3092\u4E0B\u66F8\u304D\u306B\u5FA9\u5143\u3057\u307E\u3057\u305F\u3002\u8ABF\u6574\u30FB\u691C\u8A3C\u3057\u3066\u304B\u3089\u5B9F\u884C\u3067\u304D\u307E\u3059\u3002");
  }
  async function loadLibrary() {
    const data = await call("list_workflows");
    const rows = Array.isArray(data) ? data : [...data.workflows ?? [], ...(data.comfyui_canvas_only ?? []).map((name2) => ({ name: name2, source: "ComfyUI canvas" }))];
    setLibrary(rows);
    return rows;
  }
  async function loadWorkflow(workflowName) {
    if (dirtyRef.current) {
      setError("\u7DE8\u96C6\u4E2D\u306E\u4E0B\u66F8\u304D\u304C\u3042\u308A\u307E\u3059\u3002\u5148\u306B\u4FDD\u5B58\u30FBJSON\u66F8\u304D\u51FA\u3057\u3001\u307E\u305F\u306F\u300C\u4E0B\u66F8\u304D\u3092\u7834\u68C4\u300D\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002");
      return;
    }
    await act(async () => {
      const record = await call("get_workflow", { name: workflowName });
      adopt(record);
      setTab("workflow");
      await refresh();
    });
  }
  (0, import_react.useEffect)(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey));
      if (draft?.workflow) adopt(draft, true);
    } catch {
    }
    ;
    act(async () => {
      await refresh();
      await call("comfy_status");
      await loadLibrary();
      await refresh();
    });
  }, [sessionId]);
  (0, import_react.useEffect)(() => {
    if (!graph) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ name, description, workflow: graph, pinned }));
    } catch {
      setNotice("\u4E0B\u66F8\u304D\u3092\u30D6\u30E9\u30A6\u30B6\u306B\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093\u3002JSON\u3067\u66F8\u304D\u51FA\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    }
  }, [graph, name, description, pinned, draftKey]);
  (0, import_react.useEffect)(() => {
    const incoming = snapshot.latestWorkflow;
    if (!incoming || incoming.revision === revisionRef.current) return;
    revisionRef.current = incoming.revision;
    if (!dirtyRef.current) adopt({ ...incoming, pinned: incoming.name === name ? pinned : [] });
    else if (incoming.origin === "agent") setNotice("Agent\u304B\u3089\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u304C\u5C4A\u3044\u3066\u3044\u307E\u3059\u3002\u4E0B\u66F8\u304D\u3092\u4FDD\u8B77\u3057\u3066\u3044\u308B\u305F\u3081\u81EA\u52D5\u7F6E\u63DB\u3057\u3066\u3044\u307E\u305B\u3093\u3002");
  }, [snapshot.latestWorkflow?.revision]);
  const typeKey = graph ? [...new Set(Object.values(graph).map((n) => n.class_type))].sort().join("\n") : "";
  (0, import_react.useEffect)(() => {
    if (!typeKey) return;
    let alive = true;
    const types = typeKey.split("\n").filter((type) => !definitions[type]);
    if (!types.length) return;
    (async () => {
      const next = {};
      for (let i = 0; i < types.length; i += 20) Object.assign(next, await call("node_info", { node_types: types.slice(i, i + 20) }));
      if (alive) setDefinitions((old) => ({ ...old, ...next }));
    })().catch((e) => {
      if (alive) setError(e.message);
    });
    return () => {
      alive = false;
    };
  }, [typeKey, call]);
  (0, import_react.useEffect)(() => {
    if (!visible) return;
    let active = true, running = false;
    const timer = setInterval(async () => {
      if (running || document.hidden || busyRef.current) return;
      running = true;
      try {
        const state = await refresh();
        for (const job of [...state.jobs.filter(activeJob).slice(pollIndex.current), ...state.jobs.filter(activeJob).slice(0, pollIndex.current)].slice(0, 4)) {
          if (!active) break;
          try {
            await call("get_job", { job_id: job.job_id, show_image: true });
          } catch (error2) {
            if (active) setError(`\u30B8\u30E7\u30D6 ${job.job_id}: ${error2.message}`);
          }
        }
        pollIndex.current = (pollIndex.current + 4) % Math.max(1, state.jobs.filter(activeJob).length);
        if (state.jobs.some(activeJob)) await call("comfy_status");
        if (active) await refresh();
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        running = false;
      }
    }, 5e3);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [visible, refresh, call]);
  const node = graph?.[selected], spec = node ? definitions[node.class_type] : null;
  async function updateDefinitions() {
    const types = [...new Set(Object.values(graph ?? {}).map((node2) => node2.class_type))], next = {};
    for (let i = 0; i < types.length; i += 20) Object.assign(next, await call("node_info", { node_types: types.slice(i, i + 20) }));
    setDefinitions((old) => ({ ...old, ...next }));
    setNotice("\u63A5\u7D9A\u5148\u304B\u3089\u30CE\u30FC\u30C9\u5B9A\u7FA9\u3092\u518D\u53D6\u5F97\u3057\u307E\u3057\u305F\u3002\u4E0B\u66F8\u304D\u306E\u5024\u306F\u4FDD\u6301\u3057\u3066\u3044\u307E\u3059\u3002");
  }
  async function validate() {
    const result = await call("validate_workflow", { workflow: graph });
    setReport(result);
    return result;
  }
  function discard() {
    markDirty(false);
    setGraph(null);
    setPinned([]);
    setSelected("");
    setName("");
    setDescription("");
    setReport(null);
    localStorage.removeItem(draftKey);
    history.current = { past: [], future: [] };
  }
  const status = snapshot.status;
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "comfy-studio" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-head" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-eyebrow" }, "CREATIVE WORKSPACE"), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-title" }, "ComfyUI Studio"), /* @__PURE__ */ import_react.default.createElement("button", { "aria-label": "Studio\u3092\u66F4\u65B0", disabled: busy, onClick: () => act(async () => {
    await call("comfy_status");
    await loadLibrary();
    await refresh();
  }) }, busy ? "\u51E6\u7406\u4E2D\u2026" : "\u66F4\u65B0 \u21BB")), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line" }, /* @__PURE__ */ import_react.default.createElement("span", null, /* @__PURE__ */ import_react.default.createElement("i", { className: "cs-dot" }), status ? `ComfyUI ${status.comfyui_version}` : "\u63A5\u7D9A\u3092\u78BA\u8A8D\u4E2D"), /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted" }, status ? `${status.running ?? 0} \u5B9F\u884C / ${status.queued ?? 0} \u5F85\u6A5F` : "ComfyUI MCP")), status && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted", style: { marginTop: 3 } }, status.gpu?.replace(/^cuda:\d+ /, "").split(" : ")[0], " \xB7 VRAM ", status.vram_free_gb, "/", status.vram_total_gb, " GB")), error && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-error", role: "alert" }, error, /* @__PURE__ */ import_react.default.createElement("button", { style: { float: "right", padding: "0 4px" }, "aria-label": "\u30A8\u30E9\u30FC\u3092\u9589\u3058\u308B", onClick: () => setError("") }, "\xD7")), /* @__PURE__ */ import_react.default.createElement("nav", { className: "cs-tabs", "aria-label": "ComfyUI Studio\u30BF\u30D6" }, [["artifacts", "\u6210\u679C\u7269"], ["workflow", "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC"], ["models", "\u30E2\u30C7\u30EB"], ["activity", "\u5C65\u6B74"]].map(([key, label]) => /* @__PURE__ */ import_react.default.createElement("button", { key, role: "tab", "aria-selected": tab === key, onClick: () => setTab(key) }, label, key === "artifacts" && snapshot.jobs.length ? ` ${snapshot.jobs.length}` : "", key === "workflow" && dirty ? " \xB7" : ""))), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-body" }, notice && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-note" }, notice), snapshot.uncertainRequests?.length > 0 && /* @__PURE__ */ import_react.default.createElement("details", { className: "cs-note" }, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u672A\u78BA\u5B9A\u306E\u9001\u4FE1 ", snapshot.uncertainRequests.length, "\u4EF6 \u2014 \u30B8\u30E7\u30D6\u306E\u7167\u5408\u304C\u5FC5\u8981\u3067\u3059"), /* @__PURE__ */ import_react.default.createElement("p", null, "\u81EA\u52D5\u518D\u9001\u306F\u3057\u307E\u305B\u3093\u3002\u7D50\u679C\u4E0D\u660E\u306E\u9593\u306F\u5909\u66F4\u64CD\u4F5C\u3092\u505C\u6B62\u3057\u307E\u3059\u3002\u30B8\u30E7\u30D6\u306E\u5B9F\u884C\u72B6\u6CC1\u3092\u78BA\u8A8D\u3057\u305F\u5F8C\u3060\u3051\u3001\u4E0B\u306E\u30DC\u30BF\u30F3\u3067\u65B0\u898F\u5B9F\u884C\u3092\u8A31\u53EF\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u672A\u78BA\u5B9A\u304C", snapshot.retention?.pending ?? 32, "\u4EF6\u306B\u306A\u308B\u3068\u65B0\u898F\u9001\u4FE1\u3092\u505C\u6B62\u3057\u307E\u3059\u3002"), snapshot.uncertainRequests.map((request) => /* @__PURE__ */ import_react.default.createElement("div", { key: request.id }, /* @__PURE__ */ import_react.default.createElement("strong", null, request.tool), " \xB7 ", new Date(request.at).toLocaleString(), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-job-id" }, "\u9001\u4FE1ID: ", request.id), request.job_id && /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-job-id" }, "\u30B8\u30E7\u30D6ID: ", request.job_id), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(async () => {
    await call("get_job", { job_id: request.job_id, show_image: true });
    await refresh();
  }) }, "\u30B8\u30E7\u30D6\u306E\u72B6\u614B\u3092\u78BA\u8A8D")), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(async () => {
    const result = await api({ action: "acknowledge_request", id: request.id });
    await refresh();
    setNotice(result.message);
  }) }, "\u30B8\u30E7\u30D6\u78BA\u8A8D\u6E08\u307F\u3068\u3057\u3066\u65B0\u898F\u5B9F\u884C\u3092\u8A31\u53EF")))), tab === "artifacts" && /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted", style: { marginBottom: 10 } }, "\u4FDD\u6301\u4E0A\u9650: \u6210\u679C\u7269", snapshot.retention?.jobs ?? 60, "\u4EF6 \xB7 \u30D7\u30EC\u30D3\u30E5\u30FC", snapshot.retention?.previewMB ?? 128, " MB / \u30BB\u30C3\u30B7\u30E7\u30F3\u3002\u5FC5\u8981\u306A\u753B\u50CF\u306F\u4FDD\u5B58\u3057\u3066\u304F\u3060\u3055\u3044\u3002"), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-row", style: { marginBottom: 12 } }, /* @__PURE__ */ import_react.default.createElement("input", { "aria-label": "\u65E2\u5B58\u306E\u30B8\u30E7\u30D6ID", placeholder: "\u65E2\u5B58\u306E\u30B8\u30E7\u30D6ID\u3092\u8AAD\u307F\u8FBC\u3080", value: jobId, onChange: (e) => setJobId(e.target.value), style: { flex: 1, minWidth: 100 } }), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy || !jobId.trim(), onClick: () => act(async () => {
    await call("get_job", { job_id: jobId.trim(), show_image: true });
    await refresh();
  }) }, "\u8AAD\u307F\u8FBC\u3080")), snapshot.jobs.length === 0 ? /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-empty" }, /* @__PURE__ */ import_react.default.createElement("b", null, "\u3053\u3053\u306B\u6210\u679C\u7269\u304C\u4E26\u3073\u307E\u3059"), "\u30C1\u30E3\u30C3\u30C8\u3067\u753B\u50CF\u751F\u6210\u3092\u4F9D\u983C\u3059\u308B\u304B\u3001", /* @__PURE__ */ import_react.default.createElement("br", null), "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u3092\u9078\u3093\u3067\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002", /* @__PURE__ */ import_react.default.createElement("p", null, "\u753B\u50CF\u30FB\u30B8\u30E7\u30D6\u306F\u3053\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u3054\u3068\u306B\u4FDD\u6301\u3055\u308C\u307E\u3059\u3002")) : snapshot.jobs.map((job) => /* @__PURE__ */ import_react.default.createElement("article", { className: "cs-card", key: job.job_id }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line", style: { marginBottom: 8 } }, /* @__PURE__ */ import_react.default.createElement("strong", null, job.workflowName ?? job.source ?? "ComfyUI job"), /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-badge" }, { done: "\u5B8C\u4E86", running: "\u5B9F\u884C\u4E2D", queued: "\u5F85\u6A5F\u4E2D", failed: "\u5931\u6557", unknown: "\u72B6\u614B\u4E0D\u660E" }[job.status] ?? job.status)), job.prompt && /* @__PURE__ */ import_react.default.createElement("p", { style: { margin: "4px 0 8px" } }, job.prompt), job.previews?.map((image) => /* @__PURE__ */ import_react.default.createElement(Preview, { key: image.id, image, api })), job.previewsExpired && job.previews?.length > 0 && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, "\u4FDD\u6301\u4E0A\u9650\u306B\u3088\u308A\u30D7\u30EC\u30D3\u30E5\u30FC\u306E\u4E00\u90E8\u3092\u6574\u7406\u3057\u307E\u3057\u305F\u3002"), job.replayExpired && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, "\u4FDD\u6301\u4E0A\u9650\u306B\u3088\u308A\u5B9F\u884C\u6642\u30B0\u30E9\u30D5\u3092\u6574\u7406\u3057\u307E\u3057\u305F\u3002"), job.status === "done" && !job.previews?.length && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-note" }, job.previewsExpired ? "\u4FDD\u6301\u4E0A\u9650\u306B\u3088\u308A\u30D7\u30EC\u30D3\u30E5\u30FC\u3092\u6574\u7406\u3057\u307E\u3057\u305F\u3002\u5FC5\u8981\u306A\u5834\u5408\u306F\u7D50\u679C\u3092\u518D\u53D6\u5F97\u3057\u3066\u304F\u3060\u3055\u3044\u3002" : "\u7D50\u679C\u3092\u53D6\u5F97\u3059\u308B\u3068\u753B\u50CF\u30D7\u30EC\u30D3\u30E5\u30FC\u304C\u8868\u793A\u3055\u308C\u307E\u3059\u3002"), job.error && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-error", style: { margin: 0 } }, job.error), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-job-id", style: { marginTop: 8 } }, job.job_id), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line", style: { marginTop: 8 } }, /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted" }, job.seconds ? `${job.seconds}\u79D2 \xB7 ` : "", new Date(job.createdAt).toLocaleTimeString()), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-row" }, job.submittedWorkflow && /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => restoreJob(job) }, "\u3053\u306E\u8A2D\u5B9A\u3092\u4E0B\u66F8\u304D\u306B\u623B\u3059"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(async () => {
    await call("get_job", { job_id: job.job_id, show_image: true });
    await refresh();
  }) }, "\u7D50\u679C\u3092\u53D6\u5F97")))))), tab === "workflow" && /* @__PURE__ */ import_react.default.createElement("fieldset", { disabled: busy }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line" }, /* @__PURE__ */ import_react.default.createElement("strong", null, "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u30E9\u30A4\u30D6\u30E9\u30EA"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(loadLibrary) }, "\u4E00\u89A7\u66F4\u65B0")), /* @__PURE__ */ import_react.default.createElement("input", { "aria-label": "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u3092\u7D5E\u308A\u8FBC\u3080", placeholder: "\u540D\u524D\u30FB\u8AAC\u660E\u3067\u7D5E\u308A\u8FBC\u307F", value: libraryQuery, onChange: (e) => setLibraryQuery(e.target.value), style: { marginTop: 9 } }), /* @__PURE__ */ import_react.default.createElement("div", { style: { maxHeight: 160, overflow: "auto", margin: "9px 0" } }, library.length ? library.filter((row) => `${row.name} ${row.description ?? ""}`.toLowerCase().includes(libraryQuery.toLowerCase())).map((row) => /* @__PURE__ */ import_react.default.createElement("button", { className: "cs-library", key: row.name, disabled: busy, onClick: () => loadWorkflow(row.name) }, /* @__PURE__ */ import_react.default.createElement("strong", null, row.name), /* @__PURE__ */ import_react.default.createElement("span", null, row.nodes ? `${row.nodes} nodes \xB7 ` : "", row.description || row.source || "\u4FDD\u5B58\u6E08\u307F"))) : /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, "\u4FDD\u5B58\u6E08\u307F\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u306F\u307E\u3060\u3042\u308A\u307E\u305B\u3093\u3002Agent\u306B\u4F5C\u6210\u3092\u4F9D\u983C\u3059\u308B\u304B\u3001API\u5F62\u5F0F\u306EJSON\u3092\u8AAD\u307F\u8FBC\u3081\u307E\u3059\u3002")), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-toolbar" }, /* @__PURE__ */ import_react.default.createElement("button", { onClick: () => {
    setShowJson(!showJson);
    setJson(graph ? pretty(graph) : "");
  } }, "JSON\u3092", showJson ? "\u9589\u3058\u308B" : "\u8AAD\u307F\u8FBC\u307F / \u7DE8\u96C6"), graph && /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(updateDefinitions) }, "\u30CE\u30FC\u30C9\u5B9A\u7FA9\u3092\u66F4\u65B0"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy || !history.current.past.length, onClick: () => moveHistory("undo") }, "\u5143\u306B\u623B\u3059"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy || !history.current.future.length, onClick: () => moveHistory("redo") }, "\u3084\u308A\u76F4\u3059"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: discard }, "\u4E0B\u66F8\u304D\u3092\u7834\u68C4"))), showJson && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-card" }, /* @__PURE__ */ import_react.default.createElement("label", { className: "cs-label", htmlFor: "cs-workflow-json" }, "ComfyUI API\u5F62\u5F0F\u306EJSON"), /* @__PURE__ */ import_react.default.createElement("textarea", { id: "cs-workflow-json", className: "cs-code", value: json, onChange: (e) => setJson(e.target.value), placeholder: '{"1":{"class_type":"...","inputs":{}}}' }), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-toolbar" }, /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => {
    try {
      const parsed = JSON.parse(json);
      const next = assertGraph(parsed.workflow ?? parsed);
      if (graph) change(next);
      else adopt({ workflow: next, name: "studio-draft" }, true);
      setSelected(Object.keys(next)[0]);
      setShowJson(false);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  } }, "\u4E0B\u66F8\u304D\u306B\u9069\u7528"), graph && /* @__PURE__ */ import_react.default.createElement("a", { download: `${name || "workflow"}.json`, href: `data:application/json;charset=utf-8,${encodeURIComponent(pretty(graph))}` }, "JSON\u3092\u66F8\u304D\u51FA\u3059"))), graph ? /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted" }, Object.keys(graph).length, " nodes \xB7 ", dirty ? "\u672A\u4FDD\u5B58\u306E\u4E0B\u66F8\u304D" : "\u8AAD\u307F\u8FBC\u307F\u6E08\u307F"), /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-badge" }, "API graph")), /* @__PURE__ */ import_react.default.createElement(Graph, { graph, selected, onSelect: setSelected }), /* @__PURE__ */ import_react.default.createElement("details", { className: "cs-card", open: true }, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u30AF\u30A4\u30C3\u30AF\u8ABF\u6574"), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted", style: { margin: "6px 0 12px" } }, "\u3088\u304F\u4F7F\u3046\u5165\u529B\u3068\u30D4\u30F3\u7559\u3081\u3057\u305F\u5165\u529B\u3092\u307E\u3068\u3081\u3066\u7DE8\u96C6\u3067\u304D\u307E\u3059\u3002\u63A5\u7D9A\u306F\u5909\u66F4\u3057\u307E\u305B\u3093\u3002"), quickParameters(graph, definitions, pinned).map((param) => /* @__PURE__ */ import_react.default.createElement("div", { key: param.key }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted" }, "#", param.nodeId, " ", param.title, param.pinned ? " \xB7 \u30D4\u30F3\u7559\u3081" : ""), /* @__PURE__ */ import_react.default.createElement("button", { "aria-label": `\u30CE\u30FC\u30C9 ${param.nodeId} \u3092\u9078\u629E`, onClick: () => setSelected(param.nodeId) }, "\u30CE\u30FC\u30C9\u3078")), /* @__PURE__ */ import_react.default.createElement(InputField, { input: param.input, value: param.value, spec: param.spec, graph, definitions, update: (value) => change(changeInput(graph, param.nodeId, param.input, value)) }))), !quickParameters(graph, definitions, pinned).length && /* @__PURE__ */ import_react.default.createElement("p", { className: "cs-muted" }, "\u4E0B\u306E\u30CE\u30FC\u30C9\u7DE8\u96C6\u3067\u5165\u529B\u3092\u30D4\u30F3\u7559\u3081\u3057\u3066\u304F\u3060\u3055\u3044\u3002")), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-node-grid" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-node-list" }, Object.entries(graph).map(([id, n]) => /* @__PURE__ */ import_react.default.createElement("button", { key: id, "aria-pressed": selected === id, onClick: () => setSelected(id) }, /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-node-id" }, "#", id), n._meta?.title ?? n.class_type))), /* @__PURE__ */ import_react.default.createElement("div", null, node ? /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-section", style: { marginTop: 0 } }, "#", selected, " ", node.class_type), spec?.error && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-note" }, spec.error), [.../* @__PURE__ */ new Set([...Object.keys(node.inputs), ...Object.keys(spec?.inputs ?? {})])].map((input) => /* @__PURE__ */ import_react.default.createElement("div", { key: `${selected}:${input}` }, /* @__PURE__ */ import_react.default.createElement(InputField, { input, value: node.inputs[input], spec: spec?.inputs?.[input], graph: Object.fromEntries(Object.entries(graph).filter(([id]) => id !== selected)), definitions, update: (value) => {
    if (value === void 0) {
      const next = structuredClone(graph);
      delete next[selected].inputs[input];
      change(next);
    } else change(changeInput(graph, selected, input, value));
  } }), ["string", "number", "boolean"].includes(typeof node.inputs[input]) && spec?.inputs?.[input]?.kind !== "link" && /* @__PURE__ */ import_react.default.createElement("label", { className: "cs-check", style: { margin: "-6px 0 14px" } }, /* @__PURE__ */ import_react.default.createElement("input", { type: "checkbox", "aria-label": `${input} \u3092\u30D4\u30F3\u7559\u3081`, checked: pinned.includes(parameterKey(selected, input)), onChange: (e) => {
    const key = parameterKey(selected, input);
    setPinned((old) => e.target.checked ? [...old, key] : old.filter((p) => p !== key));
  } }), "\u30AF\u30A4\u30C3\u30AF\u8ABF\u6574\u306B\u30D4\u30F3\u7559\u3081"))), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => {
    change(removeNode(graph, selected));
    setSelected(Object.keys(graph).find((id) => id !== selected) ?? "");
  } }, "\u3053\u306E\u30CE\u30FC\u30C9\u3092\u524A\u9664")) : /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, "\u30CE\u30FC\u30C9\u3092\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044\u3002"))), /* @__PURE__ */ import_react.default.createElement("details", { style: { margin: "15px 0" } }, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u30CE\u30FC\u30C9\u3092\u8FFD\u52A0"), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-row", style: { marginTop: 8 } }, /* @__PURE__ */ import_react.default.createElement("input", { "aria-label": "\u8FFD\u52A0\u3059\u308B\u30CE\u30FC\u30C9\u3092\u691C\u7D22", value: query, onChange: (e) => setQuery(e.target.value), placeholder: "\u4F8B: sampler / lora", style: { flex: 1, minWidth: 100 } }), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy || !query.trim(), onClick: () => act(async () => {
    const found = await call("node_info", { query: query.trim() });
    setHits(Array.isArray(found) ? found : found.nodes ?? found.results ?? []);
  }) }, "\u691C\u7D22")), hits.map((hit) => /* @__PURE__ */ import_react.default.createElement("button", { className: "cs-library", key: hit.node_type, disabled: busy, onClick: () => act(async () => {
    const data = await call("node_info", { node_types: [hit.node_type] });
    setDefinitions((old) => ({ ...old, ...data }));
    const added = addNode(graph, hit.node_type, data[hit.node_type]);
    change(added.graph);
    setSelected(added.id);
  }) }, hit.display_name || hit.node_type, /* @__PURE__ */ import_react.default.createElement("span", null, hit.category)))), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-card" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-field" }, /* @__PURE__ */ import_react.default.createElement("label", { className: "cs-label" }, "\u4FDD\u5B58\u540D"), /* @__PURE__ */ import_react.default.createElement("input", { "aria-label": "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u4FDD\u5B58\u540D", value: name, onChange: (e) => {
    setName(e.target.value);
    markDirty(true);
  }, placeholder: "my-workflow-v2" })), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-field" }, /* @__PURE__ */ import_react.default.createElement("label", { className: "cs-label" }, "\u8AAC\u660E"), /* @__PURE__ */ import_react.default.createElement("textarea", { "aria-label": "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u306E\u8AAC\u660E", rows: "2", value: description, onChange: (e) => {
    setDescription(e.target.value);
    markDirty(true);
  } })), /* @__PURE__ */ import_react.default.createElement("label", { className: "cs-check" }, /* @__PURE__ */ import_react.default.createElement("input", { type: "checkbox", checked: overwrite, onChange: (e) => setOverwrite(e.target.checked) }), "\u540C\u540D\u306E\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u3092\u4E0A\u66F8\u304D\u3059\u308B"), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-toolbar" }, /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(async () => {
    await api({ action: "share_draft", draft: { workflow: graph, name, description } });
    await refresh();
    setNotice("\u3053\u306E\u4E0B\u66F8\u304D\u3092Operator\u306B\u5171\u6709\u3057\u307E\u3057\u305F\u3002\u4EE5\u5F8C\u306E\u7DE8\u96C6\u3092\u6E21\u3059\u306B\u306F\u518D\u5171\u6709\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u4FDD\u5B58\u3084\u5B9F\u884C\u306F\u3057\u3066\u3044\u307E\u305B\u3093\u3002");
  }) }, "\u4E0B\u66F8\u304D\u3092Operator\u306B\u5171\u6709"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(validate) }, "\u691C\u8A3C\u3059\u308B"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy || !name.trim(), onClick: () => act(async () => {
    await call("save_workflow", { name: name.trim(), workflow: graph, description }, { requestId: uuid(), overwrite });
    markDirty(false);
    await loadLibrary();
    await refresh();
    setNotice("\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F\u3002");
  }) }, "\u4FDD\u5B58"), /* @__PURE__ */ import_react.default.createElement("button", { className: "cs-primary", disabled: busy, onClick: () => act(async () => {
    pendingRun.current ??= uuid();
    const job = await call("run_workflow", { workflow: graph, name }, { requestId: pendingRun.current });
    pendingRun.current = null;
    await refresh();
    setTab("artifacts");
    setNotice(`\u30B8\u30E7\u30D6\u3092\u9001\u4FE1\u3057\u307E\u3057\u305F: ${job.job_id}`);
  }) }, "\u691C\u8A3C\u3057\u3066\u5B9F\u884C \u2192")), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, "\u5B9F\u884C\u306F\u73FE\u5728\u306E\u4E0B\u66F8\u304D\u3092\u4F7F\u7528\u3057\u307E\u3059\u3002\u5B9F\u884C\u524D\u306B\u30B5\u30FC\u30D0\u30FC\u3067\u518D\u691C\u8A3C\u3057\u307E\u3059\u3002"), snapshot.sharedDraft && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, "Operator\u5171\u6709: ", snapshot.sharedDraft.name || "\u4E0B\u66F8\u304D", " \xB7 ", new Date(snapshot.sharedDraft.sharedAt).toLocaleString(), " \u6642\u70B9\u3002\u4EE5\u5F8C\u306E\u7DE8\u96C6\u306F\u518D\u5171\u6709\u304C\u5FC5\u8981\u3067\u3059\u3002")), report && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-card cs-result", role: "status" }, /* @__PURE__ */ import_react.default.createElement("strong", null, report.errors?.length ? `${report.errors.length}\u4EF6\u306E\u30A8\u30E9\u30FC` : "\u691C\u8A3COK"), /* @__PURE__ */ import_react.default.createElement("pre", { style: { whiteSpace: "pre-wrap", font: "inherit" } }, pretty(report)))) : /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-empty" }, /* @__PURE__ */ import_react.default.createElement("b", null, "\u30CE\u30FC\u30C9\u3092\u8ABF\u6574\u3067\u304D\u308B\u4F5C\u696D\u30B9\u30DA\u30FC\u30B9"), "\u30E9\u30A4\u30D6\u30E9\u30EA\u304B\u3089\u9078\u3076\u304B\u3001\u30C1\u30E3\u30C3\u30C8\u3067", /* @__PURE__ */ import_react.default.createElement("br", null), "\u30EF\u30FC\u30AF\u30D5\u30ED\u30FC\u306E\u4F5C\u6210\u30FB\u8AAD\u307F\u8FBC\u307F\u3092\u4F9D\u983C\u3057\u3066\u304F\u3060\u3055\u3044\u3002")), tab === "models" && /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line" }, /* @__PURE__ */ import_react.default.createElement("strong", null, "\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u6E08\u307F\u30E2\u30C7\u30EB"), /* @__PURE__ */ import_react.default.createElement("button", { disabled: busy, onClick: () => act(async () => setModels(await call("list_models"))) }, "\u53D6\u5F97\u3059\u308B")), /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-note", style: { marginTop: 12 } }, "\u30B5\u30FC\u30D0\u30FC\u306B\u5B9F\u5728\u3059\u308B\u30E2\u30C7\u30EB\u306E\u307F\u8868\u793A\u3057\u307E\u3059\u3002\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3084\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u306F\u884C\u3044\u307E\u305B\u3093\u3002"), models && Object.entries(models).map(([folder, files]) => /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-card", key: folder }, /* @__PURE__ */ import_react.default.createElement("strong", null, folder), /* @__PURE__ */ import_react.default.createElement("pre", { className: "cs-result", style: { whiteSpace: "pre-wrap" } }, Array.isArray(files) ? files.join("\n") : pretty(files))))), tab === "activity" && /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-muted" }, "\u64CD\u4F5C\u5C65\u6B74\u306F\u6700\u65B0", snapshot.retention?.activity ?? 80, "\u4EF6\u3067\u3059\u3002\u540C\u3058\u72B6\u614B\u306E\u81EA\u52D5\u78BA\u8A8D\u306F\u8FFD\u52A0\u3057\u307E\u305B\u3093\u3002"), snapshot.activity.length ? snapshot.activity.map((entry, i) => /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-activity", key: `${entry.at}:${i}` }, /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-line" }, /* @__PURE__ */ import_react.default.createElement("strong", null, entry.tool), /* @__PURE__ */ import_react.default.createElement("span", { className: "cs-muted" }, entry.origin === "panel" ? "\u30D1\u30CD\u30EB" : "Agent", " \xB7 ", new Date(entry.at).toLocaleTimeString())), (entry.name || entry.job_id) && /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-job-id" }, entry.name ?? entry.job_id))) : /* @__PURE__ */ import_react.default.createElement("div", { className: "cs-empty" }, "\u3053\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u64CD\u4F5C\u5C65\u6B74\u306F\u307E\u3060\u3042\u308A\u307E\u305B\u3093\u3002"))));
}
var inject = ["slots", "sessions", "connection", "sidebarRight", "sidebarRightTabs"];
function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.comfyuiStudio = "0.6.0";
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: KIND, title: () => "ComfyUI Studio", guide: [{ id: "comfyui-studio", order: 35, title: () => "ComfyUI Studio", description: () => "\u6210\u679C\u7269\u30FB\u30B8\u30E7\u30D6\u30FB\u30CE\u30FC\u30C9\u3092\u78BA\u8A8D\u3057\u3066\u8ABF\u6574", icon: () => /* @__PURE__ */ import_react.default.createElement("span", null, "\u25C8") }] }));
  function Body(props) {
    const { tab } = props.useTabInfo();
    return /* @__PURE__ */ import_react.default.createElement(Studio, { key: props.sessionId, sessionId: props.sessionId, connection: ctx.connection, visible: tab.visible });
  }
  function Open() {
    return /* @__PURE__ */ import_react.default.createElement("button", { "aria-label": "ComfyUI Studio\u3092\u958B\u304F", onClick: () => ctx.sidebarRight.openTab(KIND), style: { border: "1px solid rgba(150,180,160,.3)", background: "transparent", color: "inherit", borderRadius: 6, padding: "3px 9px", fontSize: 11, cursor: "pointer" } }, "\u25C8 ComfyUI Studio");
  }
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: ID }, Body)));
  ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name: "conversation.session.header.actions", id: "comfyui-studio-open", order: 15 }, Open)));
}

return module.exports;}});
