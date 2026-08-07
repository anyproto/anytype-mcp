import { OpenAPIV3 } from "openapi-types";
import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpClientError } from "../../client/http-client";
import { batchGetObjectsSchema, runBatchGetObjects } from "../custom-tools";

function createOpenApiLookup(): Record<string, OpenAPIV3.OperationObject & { method: string; path: string }> {
  return {
    "API-get-object": {
      operationId: "get_object",
      method: "get",
      path: "/v1/spaces/{space_id}/objects/{object_id}",
      parameters: [
        { name: "space_id", in: "path", required: true, schema: { type: "string" } },
        { name: "object_id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: { "200": { description: "The retrieved object" } },
    },
  };
}

function createHttpClientMock() {
  const executeOperation = vi.fn();
  const httpClient = {
    executeOperation,
  } as unknown as HttpClient;
  return { httpClient, executeOperation };
}

function fulfilledObject(objectId: string) {
  return { data: { id: objectId, name: `object-${objectId}` }, status: 200, headers: {} };
}

function rejected404(objectId: string) {
  return Promise.reject(new HttpClientError("Not Found", 404, { error: "object not found" }));
}

function rejectedNetwork(objectId: string) {
  return Promise.reject(new Error(`network error for ${objectId}`));
}

describe("batchGetObjectsSchema", () => {
  it("accepts a valid input", () => {
    const result = batchGetObjectsSchema.parse({
      space_id: "space-1",
      object_ids: ["a", "b"],
    });
    expect(result).toEqual({ space_id: "space-1", object_ids: ["a", "b"], concurrency: 5 });
  });

  it("defaults concurrency to 5", () => {
    const result = batchGetObjectsSchema.parse({ space_id: "s", object_ids: ["a"] });
    expect(result.concurrency).toBe(5);
  });

  it("rejects empty object_ids", () => {
    expect(() => batchGetObjectsSchema.parse({ space_id: "s", object_ids: [] })).toThrow();
  });

  it("rejects more than 100 object IDs", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    expect(() => batchGetObjectsSchema.parse({ space_id: "s", object_ids: ids })).toThrow();
  });
});

describe("runBatchGetObjects", () => {
  it("returns found objects for all requested IDs", async () => {
    const { httpClient, executeOperation } = createHttpClientMock();
    executeOperation.mockResolvedValue(fulfilledObject("a"));

    const result = await runBatchGetObjects(httpClient, createOpenApiLookup(), {
      space_id: "space-1",
      object_ids: ["a"],
    });

    expect(result.found).toEqual([{ id: "a", name: "object-a" }]);
    expect(result.missing).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("reports missing (404) and failed IDs separately while keeping found objects", async () => {
    const { httpClient, executeOperation } = createHttpClientMock();
    executeOperation.mockImplementation((_op: unknown, params: { object_id: string }) => {
      if (params.object_id === "missing") return rejected404(params.object_id);
      if (params.object_id === "error") return rejectedNetwork(params.object_id);
      return fulfilledObject(params.object_id);
    });

    const result = await runBatchGetObjects(httpClient, createOpenApiLookup(), {
      space_id: "space-1",
      object_ids: ["found", "missing", "error"],
    });

    expect(result.found).toEqual([{ id: "found", name: "object-found" }]);
    expect(result.missing).toEqual(["missing"]);
    expect(result.failed).toEqual([{ id: "error", error: "network error for error" }]);
  });

  it("fans out a separate get_object call per ID", async () => {
    const { httpClient, executeOperation } = createHttpClientMock();
    executeOperation.mockResolvedValue(fulfilledObject("a"));

    await runBatchGetObjects(httpClient, createOpenApiLookup(), {
      space_id: "space-1",
      object_ids: ["a", "b", "c"],
    });

    expect(executeOperation).toHaveBeenCalledTimes(3);
    expect(executeOperation).toHaveBeenNthCalledWith(1, expect.anything(), {
      space_id: "space-1",
      object_id: "a",
    });
    expect(executeOperation).toHaveBeenNthCalledWith(2, expect.anything(), {
      space_id: "space-1",
      object_id: "b",
    });
    expect(executeOperation).toHaveBeenNthCalledWith(3, expect.anything(), {
      space_id: "space-1",
      object_id: "c",
    });
  });

  it("respects the concurrency limit when batching", async () => {
    const { httpClient, executeOperation } = createHttpClientMock();
    executeOperation.mockResolvedValue(fulfilledObject("a"));

    const ids = ["1", "2", "3", "4", "5", "6"];
    await runBatchGetObjects(httpClient, createOpenApiLookup(), {
      space_id: "space-1",
      object_ids: ids,
      concurrency: 2,
    });

    expect(executeOperation).toHaveBeenCalledTimes(6);
  });

  it("deduplicates repeated object IDs", async () => {
    const { httpClient, executeOperation } = createHttpClientMock();
    executeOperation.mockResolvedValue(fulfilledObject("a"));

    const result = await runBatchGetObjects(httpClient, createOpenApiLookup(), {
      space_id: "space-1",
      object_ids: ["a", "a", "b", "b"],
    });

    expect(executeOperation).toHaveBeenCalledTimes(2);
    expect(result.found).toHaveLength(2);
  });

  it("throws when the get_object operation is missing from the spec", async () => {
    const { httpClient } = createHttpClientMock();

    await expect(runBatchGetObjects(httpClient, {}, { space_id: "space-1", object_ids: ["a"] })).rejects.toThrow(
      "API-get-object",
    );
  });
});
