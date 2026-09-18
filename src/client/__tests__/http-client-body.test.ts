import type { InternalAxiosRequestConfig } from "axios";
import { URL } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAPIToMCPConverter } from "../../openapi/parser";
import { HttpClient, HttpClientError } from "../http-client";

describe("MCP JSON request bodies", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function setup(
    schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
    components: OpenAPIV3.ComponentsObject = {},
    referenceRequestBody = false,
    headers: Record<string, string> = {},
    extraParameters: OpenAPIV3.ParameterObject[] = [],
  ) {
    const requestBody: OpenAPIV3.RequestBodyObject = {
      required: true,
      content: { "application/json": { schema } },
    };
    const spec: OpenAPIV3.Document = {
      openapi: "3.0.0",
      info: { title: "Request body regression", version: "1" },
      servers: [{ url: "http://localhost:31009" }],
      components: {
        ...components,
        parameters: {
          IfMatch: { name: "If-Match", in: "header", schema: { type: "string" } },
        },
        requestBodies: { Document: requestBody },
      },
      paths: {
        "/v2/spaces/{space_id}/objects": {
          post: {
            operationId: "write_document",
            parameters: [
              { name: "space_id", in: "path", required: true, schema: { type: "string" } },
              { name: "dry_run", in: "query", schema: { type: "boolean" } },
              { name: "create_missing_options", in: "query", schema: { type: "boolean" } },
              { name: "ids", in: "query", schema: { type: "string" } },
              { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
              { $ref: "#/components/parameters/IfMatch" },
              ...extraParameters,
            ],
            requestBody: referenceRequestBody ? { $ref: "#/components/requestBodies/Document" } : requestBody,
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const { zip } = new OpenAPIToMCPConverter(spec).convertToMCPTools();
    const { openApi: operation, mcp: tool } = zip["API-write-document"];
    const client = new HttpClient({ baseUrl: "http://localhost:31009", headers }, spec);
    const api = await client["api"];
    // Capture the serialized request after the real OpenAPI client and Axios
    // have mapped parameters and transformed the payload, without making HTTP calls.
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      data: { ok: true },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    }));
    api.defaults.adapter = adapter;
    return { client, operation, tool, adapter, api };
  }

  it("routes concise aliases and accepts matching legacy values", async () => {
    const { client, operation, tool, adapter } = await setup({ type: "object" });
    expect(tool.inputSchema.properties).toHaveProperty("expected_etag");
    expect(tool.inputSchema.properties).toHaveProperty("request_key");
    expect(tool.inputSchema.properties).not.toHaveProperty("If-Match");
    expect(tool.inputSchema.properties).not.toHaveProperty("Idempotency-Key");
    await client.executeOperation(operation, {
      space_id: "space-1",
      body: { name: "Test" },
      expected_etag: '"revision"',
      request_key: "retry-1",
      "Idempotency-Key": "retry-1",
    });
    const config = adapter.mock.calls[0][0];
    expect(JSON.parse(config.data)).toEqual({ name: "Test" });
    expect(config.headers.get("If-Match")).toBe('"revision"');
    expect(config.headers.get("Idempotency-Key")).toBe("retry-1");
  });

  it.each([
    { expected_etag: "a", "If-Match": "b" },
    { request_key: "a", "Idempotency-Key": "b" },
  ])("rejects conflicting aliases before sending a request", async (aliases) => {
    const { client, operation, adapter } = await setup({ type: "object" });
    await expect(client.executeOperation(operation, { space_id: "space-1", body: {}, ...aliases })).rejects.toThrow(
      "Conflicting values",
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it("uses a different generated key for separate identical writes", async () => {
    const { client, operation, adapter } = await setup({ type: "object" });
    const args = { space_id: "space-1", body: { name: "Test" } };
    const first = await client.executeOperation(operation, args);
    const second = await client.executeOperation(operation, args);
    expect(first.requestKey).toBeTruthy();
    expect(first.requestKey).not.toBe(second.requestKey);
    expect(adapter.mock.calls.map(([config]) => config.headers.get("Idempotency-Key"))).toEqual([
      first.requestKey,
      second.requestKey,
    ]);
    expect(args).not.toHaveProperty("request_key");
  });

  it("reuses a prepared key when a transport interceptor retries the same request", async () => {
    const { client, operation, adapter, api } = await setup({ type: "object" });
    let firstKey: unknown;
    adapter.mockImplementationOnce(async (config) => {
      firstKey = config.headers.get("Idempotency-Key");
      throw Object.assign(new Error("Temporary connection failure"), { config });
    });
    api.interceptors.response.use(undefined, (error) => api.request(error.config));

    const response = await client.executeOperation(operation, { space_id: "space-1", body: { name: "Test" } });

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(response.requestKey).toBe(firstKey);
    expect(adapter.mock.calls[1][0].headers.get("Idempotency-Key")).toBe(firstKey);
  });

  it("returns a retry key on ambiguous transport failures without automatically retrying", async () => {
    const { client, operation, adapter } = await setup({ type: "object" });
    adapter.mockRejectedValueOnce(new Error("Connection lost"));
    let failure: HttpClientError | undefined;
    try {
      await client.executeOperation(operation, { space_id: "space-1", body: { name: "Test" } });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpClientError);
      failure = error as HttpClientError;
    }
    expect(adapter).toHaveBeenCalledOnce();
    expect(failure?.data).toMatchObject({ code: "transport_error" });
    expect(failure?.requestKey).toBeTruthy();
    await client.executeOperation(operation, {
      space_id: "space-1",
      body: { name: "Test" },
      request_key: failure!.requestKey,
    });
    expect(adapter.mock.calls[1][0].headers.get("Idempotency-Key")).toBe(failure!.requestKey);
  });

  it("preserves a stale-etag error instead of retrying an unconditional update", async () => {
    const { client, operation, adapter } = await setup({ type: "object" });
    const details = {
      code: "etag_mismatch",
      message: "The object changed",
      issues: [{ path: "/expected_etag" }],
      hint: "Read it again",
    };
    adapter.mockRejectedValueOnce({
      response: { status: 412, statusText: "Precondition Failed", data: details, headers: { etag: '"new"' } },
    });
    await expect(
      client.executeOperation(operation, { space_id: "space-1", body: {}, expected_etag: '"old"' }),
    ).rejects.toMatchObject({
      status: 412,
      data: details,
      requestKey: expect.any(String),
    });
    expect(adapter).toHaveBeenCalledOnce();
    expect(adapter.mock.calls[0][0].headers.get("If-Match")).toBe('"old"');
  });

  it("uses configured headers and omits transport-only arguments from flat bodies", async () => {
    const { client, operation, adapter } = await setup(
      { type: "object", properties: { name: { type: "string" } } },
      {},
      false,
      { Authorization: "Bearer configured", "Anytype-Version": "2025-11-08" },
      ["Authorization", "Anytype-Version", "Range"].map((name) => ({ name, in: "header", schema: { type: "string" } })),
    );
    await client.executeOperation(operation, {
      space_id: "space-1",
      name: "Test",
      Authorization: "Bearer injected",
      "Anytype-Version": "other",
      Range: "bytes=0-10",
    });
    const config = adapter.mock.calls[0][0];
    expect(JSON.parse(config.data)).toEqual({ name: "Test" });
    expect(config.headers.get("Authorization")).toBe("Bearer configured");
    expect(config.headers.get("Anytype-Version")).toBe("2025-11-08");
    expect(config.headers.has("Range")).toBe(false);
  });

  it("reports missing required configuration-owned headers", async () => {
    const { client, operation, adapter } = await setup({ type: "object" }, {}, false, {}, [
      { name: "Anytype-Version", in: "header", required: true, schema: { type: "string" } },
    ]);
    await expect(client.executeOperation(operation, { space_id: "space-1", body: {} })).rejects.toThrow(
      "must be set in OPENAPI_MCP_HEADERS",
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it("rejects a globally configured idempotency key", async () => {
    await expect(setup({ type: "object" }, {}, false, { "idempotency-key": "same-for-every-write" })).rejects.toThrow(
      "global Idempotency-Key",
    );
  });

  it("logs only request metadata when debug output is enabled", async () => {
    vi.stubEnv("ANYTYPE_MCP_DEBUG", "1");
    const { client, operation } = await setup({ type: "object" });
    await client.executeOperation(operation, {
      space_id: "private-space",
      body: { secret: "private-content" },
      request_key: "private-retry-key",
    });
    expect(console.error).toHaveBeenCalledWith("[anytype-mcp] request", { operationId: "write_document" });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logs).not.toContain("private-");
  });

  it.each([
    { name: "AnyBlock type", body: { formatVersion: "2.0", kind: "object_type", properties: { name: "Tomato" } } },
    { name: "object shortcut", body: { name: "test", type: "Page" } },
    { name: "AnyBlock page", body: { formatVersion: "2.0", kind: "page", properties: { name: "test" } } },
    { name: "patch operations", body: { ops: [{ op: "set", path: "/properties/name", value: "New name" }] } },
  ])("unwraps $name and routes transport parameters outside the document", async ({ body }) => {
    const { client, operation, tool, adapter, api } = await setup({ type: "object" });
    expect(tool.inputSchema.properties?.body).toMatchObject({ type: "object" });
    const args = {
      space_id: "f7rnhi",
      dry_run: true,
      create_missing_options: false,
      ids: "full",
      "If-Match": '"revision-1"',
      "Idempotency-Key": "request-1",
      body,
    };
    const originalArgs = JSON.parse(JSON.stringify(args));

    await client.executeOperation(operation, args);

    expect(adapter).toHaveBeenCalledOnce();
    const config = adapter.mock.calls[0][0];
    expect(JSON.parse(config.data)).toEqual(body);
    const url = new URL(api.getUri(config));
    expect(url.pathname).toBe("/v2/spaces/f7rnhi/objects");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      dry_run: "true",
      create_missing_options: "false",
      ids: "full",
    });
    expect(config.headers.get("If-Match")).toBe('"revision-1"');
    expect(config.headers.get("Idempotency-Key")).toBe("request-1");
    expect(config.headers.get("Content-Type")).toBe("application/json");
    expect(args).toEqual(originalArgs);
  });

  it("preserves flat fields for a referenced create-space-style schema", async () => {
    const { client, operation, tool, adapter } = await setup(
      { $ref: "#/components/schemas/CreateSpaceRequest" },
      {
        schemas: {
          CreateSpaceRequest: {
            type: "object",
            properties: { name: { type: "string" }, description: { type: "string" } },
          },
        },
      },
    );
    expect(tool.inputSchema.properties).not.toHaveProperty("body");

    await client.executeOperation(operation, {
      space_id: "f7rnhi",
      dry_run: true,
      "Idempotency-Key": "space-request",
      name: "Garden",
      description: "Vegetables",
    });

    const config = adapter.mock.calls[0][0];
    expect(JSON.parse(config.data)).toEqual({ name: "Garden", description: "Vegetables" });
    expect(config.headers.get("Idempotency-Key")).toBe("space-request");
  });

  it("keeps a document's declared body field instead of treating it as an MCP wrapper", async () => {
    const { client, operation, adapter } = await setup({
      type: "object",
      properties: { body: { type: "object" } },
    });

    await client.executeOperation(operation, { space_id: "f7rnhi", body: { text: "Keep the body key" } });

    expect(JSON.parse(adapter.mock.calls[0][0].data)).toEqual({ body: { text: "Keep the body key" } });
  });

  it("unwraps referenced request bodies and schemas", async () => {
    const { client, operation, tool, adapter } = await setup(
      { $ref: "#/components/schemas/Document" },
      { schemas: { Document: { type: "object" } } },
      true,
    );
    expect(tool.inputSchema.properties).toHaveProperty("body");

    await client.executeOperation(operation, { space_id: "f7rnhi", body: { name: "Tomato" } });

    expect(JSON.parse(adapter.mock.calls[0][0].data)).toEqual({ name: "Tomato" });
  });

  it.each<{ name: string; schema: OpenAPIV3.SchemaObject; body: unknown }>([
    { name: "empty object", schema: { type: "object" }, body: {} },
    { name: "empty array", schema: { type: "array", items: { type: "object" } }, body: [] },
    { name: "array", schema: { type: "array", items: { type: "object" } }, body: [{ op: "test" }] },
    { name: "false", schema: { type: "boolean" }, body: false },
    { name: "zero", schema: { type: "number" }, body: 0 },
    { name: "empty string", schema: { type: "string" }, body: "" },
  ])("sends an explicitly supplied $name body", async ({ schema, body }) => {
    const { client, operation, tool, adapter } = await setup(schema);
    expect(tool.inputSchema.properties).toHaveProperty("body");

    await client.executeOperation(operation, { space_id: "f7rnhi", body });

    expect(JSON.parse(adapter.mock.calls[0][0].data)).toEqual(body);
  });
});
