export function assertGraph(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.keys(graph).length) throw new Error("API形式のワークフローを指定してください。");
  if (Object.keys(graph).length > 500) throw new Error("このエディターは500ノードまで対応します。");
  for (const [id, node] of Object.entries(graph)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !node || typeof node.class_type !== "string" || !node.inputs || Array.isArray(node.inputs) || typeof node.inputs !== "object") throw new Error(`ノード ${id} の形式が不正です。`);
  }
  return graph;
}
export const isLink = value => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
export function changeInput(graph, id, input, value) {
  return { ...graph, [id]: { ...graph[id], inputs: { ...graph[id].inputs, [input]: value } } };
}
export function removeNode(graph, id) {
  const next = structuredClone(graph); delete next[id];
  for (const node of Object.values(next)) for (const [key, value] of Object.entries(node.inputs)) if (isLink(value) && value[0] === id) delete node.inputs[key];
  return next;
}
export function addNode(graph, type, definition) {
  let number = 1; while (graph[String(number)]) number++;
  const inputs = {};
  for (const [key, spec] of Object.entries(definition?.inputs ?? {})) {
    if (spec.kind === "link") continue;
    if (spec.default !== undefined) inputs[key] = spec.default;
    else if (spec.options?.length) inputs[key] = spec.options[0];
    else if (spec.required) inputs[key] = spec.type === "BOOLEAN" ? false : ["INT", "FLOAT"].includes(spec.type) ? spec.min ?? 0 : "";
  }
  return { graph: { ...graph, [number]: { class_type: type, inputs } }, id: String(number) };
}
export function graphLayout(graph) {
  const ids = Object.keys(graph), depth = {}, visiting = new Set();
  function visit(id) {
    if (depth[id] !== undefined) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = Object.values(graph[id]?.inputs ?? {}).filter(isLink).map(v => v[0]).filter(p => graph[p]);
    const d = parents.length ? Math.min(12, 1 + Math.max(...parents.map(visit))) : 0;
    visiting.delete(id); return depth[id] = d;
  }
  const rows = {}, nodes = ids.map(id => {
    const col = visit(id), row = rows[col] ?? 0; rows[col] = row + 1;
    return { id, x: 20 + col * 210, y: 20 + row * 82 };
  });
  const positions = Object.fromEntries(nodes.map(n => [n.id, n]));
  const edges = ids.flatMap(id => Object.entries(graph[id].inputs).filter(([,v]) => isLink(v) && positions[v[0]]).map(([input, v]) => ({ from: positions[v[0]], to: positions[id], input, output: v[1] })));
  return { nodes, edges, width: Math.max(400, ...nodes.map(n => n.x + 200)), height: Math.max(150, ...nodes.map(n => n.y + 76)) };
}
