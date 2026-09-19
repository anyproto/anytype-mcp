/**
 * Operation-id vocabulary — the server names its own operations by OpenAPI
 * operationId in served prose (a schema's field descriptions: "the key
 * list_properties serves"; a body's description: "its schema comes from
 * get_schema with kind object"). That is the right spelling on the HTTP
 * surface and a second vocabulary an MCP caller does not have: the eval
 * measured haiku following a bare op id half as often as the tool name.
 *
 * So wherever this server renders server prose to the model — a tool
 * listing derived from the document, a schema response — every op id it
 * has a tool for is re-spelled as that tool. The lookup is by exact id
 * against the operations this spec declares; nothing is inferred from the
 * sentence.
 */

/** operationId → the tool that runs it on this server. */
export type OpVocabulary = Record<string, string>;

/**
 * Re-spells each op id in `text` as its tool name. Only ids that contain an
 * underscore take part: `validate` or `search` is also an English word, and
 * a plain word must never turn into a tool name. Longest id first, so
 * `get_type` never cuts into `get_type_schema`; one pass, so a tool name
 * just written is never rescanned.
 */
export function respellOpIds(text: string, vocabulary: OpVocabulary): string {
  if (!text) return text;
  const ids = Object.keys(vocabulary)
    .filter((id) => Object.hasOwn(vocabulary, id) && id.includes("_") && /^[a-z0-9_]+$/.test(id) && text.includes(id))
    .sort((a, b) => b.length - a.length);
  if (ids.length === 0) return text;
  // an id is a whole token: not glued to a letter, digit, underscore, dash
  // (a tool name), dot or slash (a route or a file)
  const pattern = new RegExp(`(?<![A-Za-z0-9_./-])(?:${ids.join("|")})(?![A-Za-z0-9_./-])`, "g");
  return text.replace(pattern, (id) => vocabulary[id]);
}

/**
 * Re-spells op ids inside every string that sits under a `description` key,
 * anywhere in `node`; everything else is left as it is. A JSON Schema's
 * descriptions are the only prose it carries, and a `description` member of
 * a data object is the caller's own text and must not reach here — callers
 * apply this to schema documents only.
 */
export function respellDescriptions<T>(node: T, vocabulary: OpVocabulary): T {
  if (Array.isArray(node)) {
    return node.map((child) => respellDescriptions(child, vocabulary)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] =
        key === "description" && typeof value === "string"
          ? respellOpIds(value, vocabulary)
          : respellDescriptions(value, vocabulary);
    }
    return out as T;
  }
  return node;
}
