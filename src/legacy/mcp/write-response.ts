import type { OpenAPIV3 } from "openapi-types";

type Operation = OpenAPIV3.OperationObject & { method: string; path: string };

// These v1 writes return ObjectWithBody. Other responses, including v2 receipts,
// searches using POST, and reads, keep their API-defined shape.
const objectWrites: Record<string, { method: string; path: string }> = {
  create_object: { method: "post", path: "/v1/spaces/{space_id}/objects" },
  update_object: { method: "patch", path: "/v1/spaces/{space_id}/objects/{object_id}" },
  delete_object: { method: "delete", path: "/v1/spaces/{space_id}/objects/{object_id}" },
  create_chat: { method: "post", path: "/v1/spaces/{space_id}/chats" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
  );
}

export function compactWriteResponse(operation: Operation, data: unknown): unknown {
  const known = objectWrites[operation.operationId || ""];
  if (!known || known.method !== operation.method.toLowerCase() || known.path !== operation.path) return data;
  // Leave unfamiliar response shapes intact rather than discard useful diagnostics.
  if (!isRecord(data) || !isRecord(data.object) || typeof data.object.id !== "string" || !data.object.id) return data;

  const object = pick(data.object, ["id", "space_id", "name", "archived"]);
  if (Object.hasOwn(data.object, "type")) {
    object.type = isRecord(data.object.type) ? pick(data.object.type, ["id", "key", "name"]) : data.object.type;
  }
  // Preserve any write metadata separately from the object's content.
  Object.assign(
    object,
    pick(data.object, [
      "etag",
      "request_key",
      "dry_run",
      "warnings",
      "issues",
      "created",
      "created_blocks",
      "created_views",
      "diff_stats",
    ]),
  );
  return { ...data, object };
}
