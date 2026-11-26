import type { OpenAPIV3 } from "openapi-types";

export type ParameterPolicy =
  | { mode: "configured" }
  | { mode: "omitted" }
  | { mode: "exposed" | "idempotency"; inputName: string; description?: string; legacyName?: string };

/** Shared by tool schemas and HTTP argument routing. Header names are case-insensitive. */
export function getParameterPolicy(parameter: OpenAPIV3.ParameterObject): ParameterPolicy {
  if (parameter.in !== "header") return { mode: "exposed", inputName: parameter.name };

  switch (parameter.name.toLowerCase()) {
    case "authorization":
    case "anytype-version":
      return { mode: "configured" };
    case "idempotency-key":
      return {
        mode: "idempotency",
        inputName: "request_key",
        legacyName: "Idempotency-Key",
        description: "Optional retry key. Reuse only for the same write; otherwise generated automatically.",
      };
    case "if-match":
      return {
        mode: "exposed",
        inputName: "expected_etag",
        legacyName: "If-Match",
        description: "Update only if the object still has this etag from a previous read.",
      };
    case "range":
    case "if-none-match":
    case "if-range":
    case "last-event-id":
      if (parameter.required) {
        throw new Error(`Required header ${parameter.name} needs a transport adapter before it can be hidden`);
      }
      return { mode: "omitted" };
    default:
      return { mode: "exposed", inputName: parameter.name };
  }
}

const credentialOperations = new Set(["create_auth_challenge", "create_api_key"]);

export function isFileDownload(operation: OpenAPIV3.OperationObject & { method?: string }): boolean {
  return operation.operationId === "download_file" && operation.method?.toLowerCase() === "get";
}

/** Reasons an HTTP operation cannot be exposed as a finite MCP tool call. */
export function getOperationExclusion(
  operation: OpenAPIV3.OperationObject & { method?: string },
  path: string,
  responses: OpenAPIV3.ResponseObject[],
): string | undefined {
  if (credentialOperations.has(operation.operationId || "") || /\/auth\/(api_keys|challenges)(?:\/|$)/.test(path)) {
    return "Pairing and credential management belong to the host configuration";
  }
  for (const response of responses) {
    const mediaTypes = Object.keys(response.content || {}).map((type) => type.split(";")[0].trim().toLowerCase());
    if (mediaTypes.includes("text/event-stream")) return "Event streams require a bounded streaming adapter";
    // The file adapter saves finite binary responses locally instead of serializing them into MCP text.
    if (isFileDownload(operation)) continue;
    if (
      mediaTypes.length > 0 &&
      mediaTypes.some((type) => type !== "application/json" && !type.endsWith("+json") && type !== "text/plain")
    ) {
      return "Binary or unsupported responses require a file or response adapter";
    }
  }
  return undefined;
}
