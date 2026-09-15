import type { InternalAxiosRequestConfig } from "axios";
import { URL } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAPIToMCPConverter } from "../../openapi/parser";
import { HttpClient } from "../http-client";

describe("MCP JSON request bodies", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup(
    schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
    components: OpenAPIV3.ComponentsObject = {},
    referenceRequestBody = false,
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
            ],
            requestBody: referenceRequestBody ? { $ref: "#/components/requestBodies/Document" } : requestBody,
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const { zip } = new OpenAPIToMCPConverter(spec).convertToMCPTools();
    const { openApi: operation, mcp: tool } = zip["API-write-document"];
    const client = new HttpClient({ baseUrl: "http://localhost:31009" }, spec);
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
