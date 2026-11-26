// Just enough JSON-RPC 2.0 to route messages. The proxy does not validate
// envelopes: whatever is not a request or notification it can recognise is
// forwarded for Anytype to classify and answer, as its own stdio server would.

export type RequestId = string | number;

export type JsonObject = Record<string, unknown>;

export interface Request extends JsonObject {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: JsonObject;
}

export interface Notification extends JsonObject {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
}

/** JSON-RPC's reserved code for a failure inside the server (here: reaching Anytype). */
export const INTERNAL_ERROR = -32603;
export const PARSE_ERROR = -32700;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

export function isRequest(value: unknown): value is Request {
  return isObject(value) && typeof value.method === "string" && isRequestId(value.id);
}

export function isNotification(value: unknown): value is Notification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

/** A response to one of our requests, or a message Anytype sent on its own. */
export function isMessage(value: unknown): value is JsonObject {
  return isObject(value) && value.jsonrpc === "2.0";
}

export function resultResponse(id: RequestId, result: JsonObject): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: RequestId | null, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tools/call result carrying a failure the model should read (MCP's in-band error). */
export function toolError(text: string): JsonObject {
  return { content: [{ type: "text", text }], isError: true };
}
