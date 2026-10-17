import { isLink } from "./graph.js";

const common = new Set(["text", "prompt", "positive", "negative", "seed", "noise_seed", "steps", "cfg", "denoise", "width", "height", "batch_size"]);
export const parameterKey = (nodeId, input) => JSON.stringify([nodeId, input]);
const scalar = value => ["string", "number", "boolean"].includes(typeof value);

// References are node/input pairs, never inferred positive/negative identities.
// Custom nodes use the same live schema as the complete node editor.
export function quickParameters(graph, definitions = {}, pinned = []) {
  const pins = new Set(pinned);
  return Object.entries(graph).flatMap(([nodeId, node]) => Object.entries(node.inputs).flatMap(([input, value]) => {
    const key = parameterKey(nodeId, input), spec = definitions[node.class_type]?.inputs?.[input];
    if (!scalar(value) || isLink(value) || spec?.kind === "link" || (!common.has(input) && !pins.has(key))) return [];
    return [{ key, nodeId, input, value, spec, pinned: pins.has(key), title: node._meta?.title ?? node.class_type }];
  }));
}

// Add scalar checks missing from the gateway's node/link/option validation.
// Partial combo lists are not authoritative; the server checks the full list.
export function checkInputValues(graph, definitions) {
  const errors = [];
  for (const [id, node] of Object.entries(graph)) {
    const definition = definitions[node.class_type];
    if (!definition || definition.error) continue;
    for (const [input, value] of Object.entries(node.inputs)) {
      const spec = definition.inputs?.[input];
      if (!spec || isLink(value) || spec.kind === "link") continue;
      // This gateway explicitly interprets -1 as a randomized seed before
      // submitting to ComfyUI, even when object_info declares a minimum of 0.
      if ((input === "seed" || input === "noise_seed") && value === -1 && spec.type === "INT") continue;
      const label = `node ${id} (${node.class_type}): '${input}'`;
      if (["INT", "FLOAT"].includes(spec.type)) {
        if (typeof value !== "number" || !Number.isFinite(value) || (spec.type === "INT" && !Number.isInteger(value))) errors.push(`${label} は ${spec.type} の数値が必要です`);
        else if ((typeof spec.min === "number" && value < spec.min) || (typeof spec.max === "number" && value > spec.max)) errors.push(`${label} は範囲外です (${spec.min ?? "−∞"} … ${spec.max ?? "∞"})`);
      } else if (spec.type === "BOOLEAN" && typeof value !== "boolean") errors.push(`${label} は true / false が必要です`);
      else if (spec.type === "STRING" && typeof value !== "string") errors.push(`${label} は文字列が必要です`);
    }
  }
  return errors;
}
