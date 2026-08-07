import type { JSONSchema7 as IJsonSchema } from "json-schema";
import { OpenAPIV3 } from "openapi-types";
import { z } from "zod";
import { HttpClient, HttpClientError } from "../client/http-client";

/**
 * Name of the tool that fetches several objects by ID in a single call.
 *
 * The upstream Anytype API has no native batch endpoint yet (see
 * anyproto/anytype-api#36), so this tool fans out parallel `get_object`
 * requests and aggregates the results while tolerating partial failures.
 */
export const BATCH_GET_OBJECTS_TOOL_NAME = "batch_get_objects";

/**
 * Zod schema for the `batch_get_objects` input. Zod is the source of truth for
 * runtime validation; the matching JSON Schema exposed to the MCP client is
 * derived from it below so LLM function calling stays descriptive.
 */
export const batchGetObjectsSchema = z.object({
  space_id: z.string().min(1).describe("The ID of the space the objects belong to."),
  object_ids: z
    .array(z.string().min(1))
    .min(1, "At least one object ID is required")
    .max(100, "No more than 100 object IDs per call")
    .describe(
      "List of object IDs to fetch. Objects that do not exist or return an error " +
        "are reported individually instead of failing the whole request.",
    ),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of objects to fetch in parallel. Defaults to 5."),
});

export type BatchGetObjectsInput = z.infer<typeof batchGetObjectsSchema>;

/**
 * JSON Schema descriptor used by the MCP `tools/list` response. Kept in sync
 * with `batchGetObjectsSchema` while staying consistent with the plain
 * JSON-Schema style the rest of the server uses for generated tools.
 */
export const batchGetObjectsInputSchema: IJsonSchema & { type: "object" } = {
  type: "object",
  properties: {
    space_id: {
      type: "string",
      description: "The ID of the space the objects belong to.",
    },
    object_ids: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 100,
      description:
        "List of object IDs to fetch. Objects that do not exist or return an error are reported individually instead of failing the whole call.",
    },
    concurrency: {
      type: "number",
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Maximum number of objects to fetch in parallel. Defaults to 5.",
    },
  },
  required: ["space_id", "object_ids"],
};

/** The operation the batch tool fans out to (generated from the OpenAPI spec). */
const GET_OBJECT_OPERATION_KEY = "API-get-object";

function isMissingObjectError(error: unknown): boolean {
  const status = error instanceof HttpClientError ? error.status : (error as { status?: number } | undefined)?.status;
  return status === 404;
}

/**
 * Fetch multiple objects by ID with partial-failure handling.
 *
 * @returns A structured result containing successfully fetched objects, the IDs
 *   that were not found (HTTP 404) and the IDs whose fetch failed for any other
 *   reason. Never throws for per-object failures.
 */
export async function runBatchGetObjects(
  httpClient: HttpClient,
  openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>,
  rawInput: unknown,
): Promise<BatchGetObjectsResult> {
  const input = batchGetObjectsSchema.parse(rawInput);
  const getObjectOperation = openApiLookup[GET_OBJECT_OPERATION_KEY];
  if (!getObjectOperation) {
    throw new Error(`Operation "${GET_OBJECT_OPERATION_KEY}" not found in the OpenAPI spec`);
  }

  // Preserve input order and avoid duplicate IDs causing needless requests.
  const objectIds = [...new Set(input.object_ids)];
  const { space_id, concurrency } = input;

  const found: unknown[] = [];
  const missing: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (let offset = 0; offset < objectIds.length; offset += concurrency) {
    const chunk = objectIds.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      chunk.map((object_id) => httpClient.executeOperation(getObjectOperation, { space_id, object_id })),
    );

    settled.forEach((result, index) => {
      const id = chunk[index];
      if (result.status === "fulfilled") {
        found.push(result.value.data);
      } else if (isMissingObjectError(result.reason)) {
        missing.push(id);
      } else {
        const reason = result.reason as { message?: string } | undefined;
        failed.push({ id, error: reason?.message ?? String(result.reason) });
      }
    });
  }

  return { found, missing, failed };
}

export type BatchGetObjectsResult = {
  found: unknown[];
  missing: string[];
  failed: Array<{ id: string; error: string }>;
};
