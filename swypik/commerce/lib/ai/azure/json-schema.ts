/**
 * zod → JSON Schema compatibil cu `response_format: json_schema` în mod strict
 * (Azure OpenAI / OpenAI structured outputs):
 *   - orice obiect: additionalProperties=false și TOATE cheile în `required`;
 *   - câmpurile opționale devin nullable (modelul trimite null);
 *   - cuvintele-cheie nesuportate în strict (min/max length, default, format…)
 *     se scot — validarea reală o face tot zod, după răspuns.
 */
import { z } from "zod";

type Json = Record<string, unknown>;

const UNSUPPORTED = [
  "$schema",
  "default",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
];

function isNullType(n: unknown): boolean {
  return Boolean(n && typeof n === "object" && (n as Json).type === "null");
}

function nullable(node: Json): Json {
  if (Array.isArray(node.type) && node.type.includes("null")) return node;
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.some(isNullType) ? node : { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  }
  if (typeof node.type === "string") {
    const out: Json = { ...node, type: [node.type, "null"] };
    if (Array.isArray(node.enum)) out.enum = [...node.enum, null];
    return out;
  }
  return { anyOf: [node, { type: "null" }] };
}

function strictify(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(strictify);
  if (!input || typeof input !== "object") return input;
  const node: Json = { ...(input as Json) };
  for (const key of UNSUPPORTED) delete node[key];
  if (node.items) node.items = strictify(node.items);
  if (Array.isArray(node.anyOf)) node.anyOf = node.anyOf.map(strictify);
  if (node.type === "object" && node.properties && typeof node.properties === "object") {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const props: Json = {};
    for (const [key, value] of Object.entries(node.properties as Json)) {
      const child = strictify(value) as Json;
      props[key] = required.has(key) ? child : nullable(child);
    }
    node.properties = props;
    node.required = Object.keys(props);
    node.additionalProperties = false;
  }
  return node;
}

export function toStrictJsonSchema(schema: z.ZodType): Json {
  return strictify(z.toJSONSchema(schema, { io: "input" })) as Json;
}

/** null → undefined recursiv, ca `.optional()` / `.default()` din zod să se aplice. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  for (const [key, v] of Object.entries(value as Json)) {
    if (v !== null) out[key] = dropNulls(v);
  }
  return out;
}
