/**
 * Operation-id vocabulary — the server names its own operations by OpenAPI
 * operationId in served prose (a schema's field descriptions: "the key
 * list_properties serves"; a body's description: "its schema comes from
 * get_schema with kind object"). That is the right spelling on the HTTP
 * surface and a second vocabulary an MCP caller does not have: the eval
 * measured haiku following a bare op id half as often as the tool name.
 *
 * So wherever this server renders server prose to the model — the MCP tool
 * listing derived from the document, a schema response — every op id it
 * has a tool for is re-spelled as that tool. The lookup is by exact id
 * against the operations this spec declares; nothing is inferred from the
 * sentence. Only prose takes part: a schema's literal payloads (enum,
 * const, default, examples) are values, and a value is never rewritten.
 */

/** operationId → the tool that runs it on this server. */
export type OpVocabulary = Record<string, string>;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-spells each op id in `text` as its tool name. Only ids that contain an
 * underscore take part: `validate` or `search` is also an English word, and
 * a plain word must never turn into a tool name. An id is a whole token:
 * not glued to a letter, digit, underscore, dash (a tool name), slash (a
 * route) or a dot that continues into a name (`ops.list_properties`,
 * `get_schema.json`); a sentence-ending dot is fine. Longest id first, and
 * one pass, so a tool name just written is never rescanned.
 */
export function respellOpIds(text: string, vocabulary: OpVocabulary): string {
  if (!text) return text;
  const ids = Object.keys(vocabulary)
    .filter((id) => Object.hasOwn(vocabulary, id) && id.includes("_") && text.includes(id))
    .sort((a, b) => b.length - a.length);
  if (ids.length === 0) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_./-])(?:${ids.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_])`,
    "gu",
  );
  return text.replace(pattern, (id) => vocabulary[id]);
}

// the JSON Schema keywords whose value is a schema, a list of schemas, or a
// map of schemas — the only places a description is prose of the schema
// itself rather than a member of some value
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]);
const SCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_SINGLE = new Set([
  "items",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

/**
 * Re-spells op ids in the descriptions of a JSON Schema, following the
 * schema keywords only. What sits under `enum`, `const`, `default`,
 * `example`, `examples` or an unknown keyword is a value and is left as it
 * is. A shared or cyclic subschema is rewritten once and reused.
 */
export function respellSchemaDescriptions<T>(schema: T, vocabulary: OpVocabulary): T {
  return respellNode(schema, vocabulary, new Map()) as T;
}

function respellNode(node: unknown, vocabulary: OpVocabulary, memo: Map<object, unknown>): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const known = memo.get(node);
  if (known !== undefined) return known;
  memo.set(node, node); // a cycle back to this node sees the original
  const entries = Object.entries(node as Record<string, unknown>).map(([key, value]): [string, unknown] => {
    if (key === "description" && typeof value === "string") return [key, respellOpIds(value, vocabulary)];
    if (SCHEMA_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      return [
        key,
        Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([name, child]) => [
            name,
            respellNode(child, vocabulary, memo),
          ]),
        ),
      ];
    }
    if (SCHEMA_LISTS.has(key) && Array.isArray(value))
      return [key, value.map((child) => respellNode(child, vocabulary, memo))];
    if (SCHEMA_SINGLE.has(key)) {
      return [
        key,
        Array.isArray(value)
          ? value.map((child) => respellNode(child, vocabulary, memo))
          : respellNode(value, vocabulary, memo),
      ];
    }
    return [key, value];
  });
  // fromEntries defines own properties, so a member literally named
  // __proto__ survives the copy
  const out = Object.fromEntries(entries);
  memo.set(node, out);
  return out;
}
