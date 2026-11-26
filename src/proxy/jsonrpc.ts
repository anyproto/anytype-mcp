// Just enough JSON-RPC 2.0 to route messages without re-encoding them.
//
// A client's message is forwarded to Anytype byte for byte and Anytype's answer
// is written back byte for byte; the proxy parses only to decide where a message
// goes. Request ids are handled as their raw JSON text, so an id such as
// 9007199254740993 is never rounded through a JavaScript number.

/** Anytype's bound on one message (anytype-heart wrapper.MCPMaxMessageBytes). */
export const MAX_MESSAGE_BYTES = 8 << 20;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const INTERNAL_ERROR = -32603;

export type JsonObject = Record<string, unknown>;

/** A valid message from the client. */
export interface Inbound {
  /** The message as received, forwarded unchanged. */
  raw: string;
  kind: "request" | "notification" | "response";
  method?: string;
  /** A request's id as its raw JSON text: `7`, `"abc"`. */
  id?: string;
  /** params, when it is an object. */
  params?: JsonObject;
}

export interface Invalid {
  kind: "invalid";
  /** The id to answer under: the message's own when usable, else `null`. */
  id: string;
  code: number;
  message: string;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates one message and says what it is, the way Anytype's own MCP loop
 * does (wrapper.ClassifyMessage), so that nothing the proxy does itself — a
 * local tool, a cancellation, a session change — runs on an envelope Anytype
 * would refuse.
 */
export function classify(line: string): Inbound | Invalid {
  const raw = line.trim();
  const invalid = (code: number, message: string, id = "null"): Invalid => ({ kind: "invalid", id, code, message });
  if (raw.startsWith("[")) {
    return invalid(INVALID_REQUEST, "JSON-RPC batching is not supported — send one message at a time");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid(PARSE_ERROR, "parse JSON-RPC message: not valid JSON");
  }
  if (!isObject(parsed)) return invalid(INVALID_REQUEST, "a JSON-RPC message is an object");

  const idToken = rawMember(raw, "id");
  const usableId = idToken !== undefined && isIdToken(idToken) ? idToken : "null";
  const invalidHere = (message: string) => invalid(INVALID_REQUEST, message, usableId);
  if (parsed.jsonrpc !== "2.0") return invalidHere('jsonrpc must be "2.0"');
  if ("params" in parsed && (parsed.params === null || typeof parsed.params !== "object")) {
    return invalidHere("params is an object or an array");
  }
  if ("method" in parsed && typeof parsed.method !== "string") return invalidHere("method must be a string");
  const method = parsed.method as string | undefined;
  if (!method) {
    const hasResult = "result" in parsed;
    const hasError = "error" in parsed;
    if (hasResult && hasError) return invalidHere("a response carries result or error, not both");
    if (hasResult || hasError) return { raw, kind: "response" };
    return invalidHere("a request names a method");
  }
  const params = isObject(parsed.params) ? parsed.params : undefined;
  if (idToken === undefined) return { raw, kind: "notification", method, params };
  if (!isIdToken(idToken)) return invalid(INVALID_REQUEST, "id must be a string or a number");
  return { raw, kind: "request", method, id: idToken, params };
}

/** A JSON-RPC id is a string or a number; MCP forbids null. */
function isIdToken(token: string): boolean {
  return /^(?:"|-?\d)/.test(token);
}

/**
 * The raw JSON text of a top-level member of an object, or undefined when it
 * is absent; the last occurrence wins, as in JSON.parse. Expects valid JSON.
 */
export function rawMember(text: string, key: string): string | undefined {
  let i = skipSpace(text, 0);
  if (text[i] !== "{") return undefined;
  i = skipSpace(text, i + 1);
  let found: string | undefined;
  while (i < text.length && text[i] !== "}") {
    const keyEnd = endOfString(text, i);
    const name = JSON.parse(text.slice(i, keyEnd)) as string;
    const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1); // past the colon
    const valueEnd = endOfValue(text, valueStart);
    if (name === key) found = text.slice(valueStart, valueEnd);
    i = skipSpace(text, valueEnd);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return found;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && " \t\r\n".includes(text[i])) i++;
  return i;
}

/** i is at an opening quote; returns the index after the closing one. */
function endOfString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

function endOfValue(text: string, i: number): number {
  if (text[i] === '"') return endOfString(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (c === '"') {
        j = endOfString(text, j);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return j;
  }
  let j = i;
  while (j < text.length && !",}] \t\r\n".includes(text[j])) j++;
  return j;
}

/**
 * Whether two id tokens name the same request. Strings compare by value (a
 * server may re-escape them); numbers by their text, which is never rounded.
 */
export function sameId(a: string, b: string): boolean {
  if (a.startsWith('"') && b.startsWith('"')) return JSON.parse(a) === JSON.parse(b);
  return a === b;
}

/** A key for an id token: equal for ids that sameId considers equal. */
export function idKey(token: string): string {
  return token.startsWith('"') ? `s:${JSON.parse(token) as string}` : `n:${token}`;
}

export function frameResult(id: string, result: unknown): string {
  return `{"jsonrpc":"2.0","id":${id},"result":${JSON.stringify(result)}}`;
}

export function frameError(id: string, code: number, message: string): string {
  return `{"jsonrpc":"2.0","id":${id},"error":${JSON.stringify({ code, message })}}`;
}

/** A tools/call result carrying a failure the model should read (MCP's in-band error). */
export function toolError(text: string): JsonObject {
  return { content: [{ type: "text", text }], isError: true };
}

/** One line of JSON text: whitespace between tokens may hold line breaks, strings may not. */
export function oneLine(text: string): string {
  return text.trim().replace(/[\r\n]+/g, " ");
}
