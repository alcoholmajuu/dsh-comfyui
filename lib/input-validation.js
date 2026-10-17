// Upstream tool definitions are the source of truth for argument shape. Reject
// obvious input errors before creating a durable submission record.
export function assertArguments(schema, value, path = "arguments") {
  if (!schema) return;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path}: 選択肢にない値です。`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = type => type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "null" ? value === null : typeof value === type;
  if (types.length && !types.some(matches)) throw new Error(`${path}: ${types.join(" / ")} が必要です。`);
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`${path}: 数値が範囲外です。`);
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) throw new Error(`${path}: 文字数が範囲外です。`);
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new Error(`${path}: 要素数が範囲外です。`);
    if (schema.items) value.forEach((item,index) => assertArguments(schema.items,item,`${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key}: 必須入力です。`);
    for (const [key,item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (!child && schema.additionalProperties === false) throw new Error(`${path}.${key}: 未対応の入力です。`);
      if (child) assertArguments(child,item,`${path}.${key}`);
    }
  }
}
