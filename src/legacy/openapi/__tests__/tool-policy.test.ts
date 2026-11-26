import type { OpenAPIV3 } from "openapi-types";
import { describe, expect, it } from "vitest";
import { OpenAPIToMCPConverter } from "../parser";

const jsonResponse = { description: "OK", content: { "application/json": { schema: { type: "object" as const } } } };

function specFor(operation: Partial<OpenAPIV3.OperationObject>): OpenAPIV3.Document {
  return {
    openapi: "3.0.0",
    info: { title: "Policy regression", version: "1" },
    paths: {
      "/v2/example": {
        post: { operationId: "write", summary: "Write a document", responses: { "200": jsonResponse }, ...operation },
      },
    },
  };
}

describe("tool exposure policy", () => {
  it("uses identical aliases, hidden inputs, and wrapped bodies across all converters", () => {
    const spec = specFor({
      parameters: [
        ...["Authorization", "Anytype-Version", "Range", "If-None-Match", "If-Range", "Last-Event-ID"].map(
          (name) =>
            ({
              name,
              in: "header",
              schema: { type: "string" },
            }) as OpenAPIV3.ParameterObject,
        ),
        { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
        { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
        { name: "X-Required", in: "header", required: true, schema: { type: "string" } },
        { name: "dry_run", in: "query", schema: { type: "boolean" } },
      ],
      requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    });
    const converter = new OpenAPIToMCPConverter(spec);
    const [mcp] = converter.convertToMCPTools().tools.API.methods;
    expect(Object.keys(mcp.inputSchema.properties!)).toEqual([
      "expected_etag",
      "request_key",
      "X-Required",
      "dry_run",
      "body",
    ]);
    expect(mcp.inputSchema.required).toEqual(["expected_etag", "X-Required", "body"]);
    const [openai] = converter.convertToOpenAITools();
    expect(openai.type).toBe("function");
    if (openai.type !== "function") throw new Error("Unexpected tool kind");
    expect(openai.function.parameters).toEqual(mcp.inputSchema);
    expect(converter.convertToAnthropicTools()[0].input_schema).toEqual(mcp.inputSchema);
  });

  it("does not silently hide a required transport header", () => {
    const converter = new OpenAPIToMCPConverter(
      specFor({
        parameters: [{ name: "Range", in: "header", required: true, schema: { type: "string" } }],
      }),
    );
    expect(() => converter.convertToMCPTools()).toThrow("Required header Range");
  });

  it.each(["text/event-stream", "application/octet-stream", "image/png"])(
    "excludes %s responses from every format and dispatch",
    (media) => {
      const spec = specFor({ responses: { "200": { $ref: "#/components/responses/Special" } } });
      spec.components = { responses: { Special: { description: "Special response", content: { [media]: {} } } } };
      const converter = new OpenAPIToMCPConverter(spec);
      expect(converter.convertToMCPTools()).toEqual({ tools: { API: { methods: [] } }, openApiLookup: {}, zip: {} });
      expect(converter.convertToOpenAITools()).toEqual([]);
      expect(converter.convertToAnthropicTools()).toEqual([]);
    },
  );

  it("excludes a binary download even when its spec also lists JSON", () => {
    const converter = new OpenAPIToMCPConverter(
      specFor({
        responses: {
          "200": { description: "Download", content: { "application/json": {}, "application/octet-stream": {} } },
        },
      }),
    );
    expect(converter.convertToMCPTools().tools.API.methods).toEqual([]);
  });

  it("keeps identity discovery and excludes pairing and credential operations", () => {
    const spec = specFor({ tags: ["Auth"], operationId: "auth_whoami" });
    spec.paths["/v2/auth/api_keys"] = { post: { operationId: "new_key", responses: { "200": jsonResponse } } };
    spec.paths["/v2/auth/challenges"] = { post: { operationId: "new_challenge", responses: { "200": jsonResponse } } };
    expect(new OpenAPIToMCPConverter(spec).convertToMCPTools().tools.API.methods.map((tool) => tool.name)).toEqual([
      "auth-whoami",
    ]);
  });

  it.each([
    ["get_object", "get_object"],
    ["get_object", "get-object"],
    ["a".repeat(70) + "1", "a".repeat(70) + "2"],
  ])("rejects colliding final names: %s / %s", (first, second) => {
    const spec = specFor({ operationId: first });
    spec.paths["/v1/example"] = { get: { operationId: second, responses: { "200": jsonResponse } } };
    expect(() => new OpenAPIToMCPConverter(spec).convertToMCPTools()).toThrow(
      /Duplicate tool name.*v2\/example.*v1\/example/,
    );
  });

  it("keeps long advertised names and dispatch keys identical across conversions", () => {
    const converter = new OpenAPIToMCPConverter(specFor({ operationId: "a".repeat(70) }));
    const first = converter.convertToMCPTools();
    const name = `API-${first.tools.API.methods[0].name}`;
    expect(name).toHaveLength(64);
    expect(first.openApiLookup[name].operationId).toBe("a".repeat(70));
    expect(converter.convertToMCPTools()).toEqual(first);
  });

  it("applies policy to inherited and referenced parameters", () => {
    const spec = specFor({ parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 10 } }] });
    spec.components = { parameters: { Revision: { name: "If-Match", in: "header", schema: { type: "string" } } } };
    spec.paths["/v2/example"]!.parameters = [
      { $ref: "#/components/parameters/Revision" },
      { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
    ];
    const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec).convertToMCPTools();
    expect(tools.API.methods[0].inputSchema.properties).toMatchObject({
      expected_etag: { type: "string" },
      limit: { default: 10 },
    });
    expect(openApiLookup["API-write"].parameters).toHaveLength(2);
  });

  it("rejects an alias that would overwrite a document field", () => {
    const spec = specFor({
      parameters: [{ name: "If-Match", in: "header", schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": { schema: { type: "object", properties: { expected_etag: { type: "string" } } } },
        },
      },
    });
    expect(() => new OpenAPIToMCPConverter(spec).convertToMCPTools()).toThrow("conflicts with a tool parameter");
  });

  it("retains the definitions needed by recursive inputs and omits empty definitions", () => {
    const spec = specFor({
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } },
    });
    spec.components = {
      schemas: {
        Node: {
          type: "object",
          properties: { children: { type: "array", items: { $ref: "#/components/schemas/Node" } } },
        },
      },
    };
    const schema = new OpenAPIToMCPConverter(spec).convertToMCPTools().tools.API.methods[0].inputSchema;
    expect(schema.$defs).toHaveProperty("Node");
    expect(JSON.stringify(schema.$defs)).toContain("#/$defs/Node");
    expect(
      new OpenAPIToMCPConverter(specFor({})).convertToMCPTools().tools.API.methods[0].inputSchema,
    ).not.toHaveProperty("$defs");
  });
});
