import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Headers } from "node-fetch";
import { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpClientError } from "../../client/http-client";
import { MCPProxy } from "../proxy";

// Mock the dependencies
vi.mock("../../client/http-client");
vi.mock("@modelcontextprotocol/sdk/server/index.js");

describe("MCPProxy", () => {
  let proxy: MCPProxy;
  let mockOpenApiSpec: OpenAPIV3.Document;

  const getHandlers = (proxy: MCPProxy) => {
    const server = (proxy as any).server;
    return server.setRequestHandler.mock.calls
      .flatMap((x: unknown[]) => x)
      .filter((x: unknown) => typeof x === "function");
  };

  const createMockOpenApiSpec = (overrides?: Partial<OpenAPIV3.Document>): OpenAPIV3.Document => ({
    openapi: "3.0.0",
    servers: [{ url: "http://localhost:3000" }],
    info: { title: "Test API", version: "1.0.0" },
    paths: {
      "/test": {
        get: {
          operationId: "getTest",
          responses: { "200": { description: "Success" } },
        },
      },
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenApiSpec = createMockOpenApiSpec();
    proxy = new MCPProxy("test-proxy", mockOpenApiSpec);
  });

  describe("listTools handler", () => {
    it("should return converted tools from OpenAPI spec", async () => {
      const [listToolsHandler] = getHandlers(proxy);
      const result = await listToolsHandler();

      expect(result).toHaveProperty("tools");
      expect(Array.isArray(result.tools)).toBe(true);
    });

    it("should truncate tool names exceeding 64 characters", async () => {
      const specWithLongName = createMockOpenApiSpec({
        paths: {
          "/test": {
            get: {
              operationId: "a".repeat(65),
              responses: { "200": { description: "Success" } },
            },
          },
        },
      });
      const testProxy = new MCPProxy("test-proxy", specWithLongName);
      const [listToolsHandler] = getHandlers(testProxy);
      const result = await listToolsHandler();

      expect(result.tools[0].name.length).toBeLessThanOrEqual(64);
    });
  });

  describe("callTool handler", () => {
    const mockSuccessResponse = {
      data: { message: "success" },
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    };

    it("should execute operation and return formatted response", async () => {
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccessResponse);

      (proxy as any).openApiLookup = {
        "API-getTest": {
          operationId: "getTest",
          responses: { "200": { description: "Success" } },
          method: "get",
          path: "/test",
        },
      };

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: "API-getTest", arguments: {} } });

      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ message: "success" }) }],
      });
    });

    it("should throw error for non-existent operation", async () => {
      const [, callToolHandler] = getHandlers(proxy);

      await expect(callToolHandler({ params: { name: "nonExistentMethod", arguments: {} } })).rejects.toThrow(
        "Method nonExistentMethod not found",
      );
    });

    // the server's typed repair hints (see_also) are re-spelled in this
    // server's tool vocabulary on both response paths — a caller with tools
    // and no routes must not be told to issue a GET
    describe("see_also re-spelling", () => {
      const specWithOps = () =>
        createMockOpenApiSpec({
          paths: {
            "/v2/schemas/ops/{op}": {
              get: {
                operationId: "get_op_schema",
                parameters: [{ name: "op", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "Success" } },
              },
            },
            "/v2/spaces/{space_id}/properties": {
              get: {
                operationId: "list_properties",
                parameters: [{ name: "space_id", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "Success" } },
              },
            },
            "/v2/spaces/{space_id}/files/{file_id}/content": {
              get: {
                operationId: "download_file",
                parameters: [
                  { name: "space_id", in: "path", required: true, schema: { type: "string" } },
                  { name: "file_id", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: { "200": { description: "bytes", content: { "application/octet-stream": {} } } },
              },
            },
            "/v2/spaces": { get: { operationId: "list_spaces", responses: { "200": { description: "Success" } } } },
          },
        });

      it("re-spells an error envelope's issues", async () => {
        const testProxy = new MCPProxy("test-proxy", specWithOps());
        const data = {
          status: 400,
          code: "validation_failed",
          message: "invalid set_properties op",
          issues: [
            {
              path: "ops[0]",
              message: "unknown field",
              hint: "GET /v2/schemas/ops/set_properties for the op's schema and example",
              see_also: [{ op: "get_op_schema", params: { op: "set_properties" } }],
            },
          ],
        };
        (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(
          Object.assign(new HttpClientError("Bad Request", 400, data), { status: 400, data }),
        );

        const [, callToolHandler] = getHandlers(testProxy);
        const result = await callToolHandler({ params: { name: "API-get-op-schema", arguments: { op: "x" } } });
        const body = JSON.parse(result.content[0].text);

        expect(result.isError).toBe(true);
        expect(body.issues[0].hint).toBe(`API-get-op-schema {"op":"set_properties"} for the op's schema and example`);
        expect(body.issues[0].see_also[0].tool).toBe("API-get-op-schema");
        expect(body.issues[0].see_also[0].args).toEqual({ op: "set_properties" });
      });

      it("re-spells a success envelope's warnings", async () => {
        const testProxy = new MCPProxy("test-proxy", specWithOps());
        (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
          ...mockSuccessResponse,
          data: {
            data: [],
            warnings: [
              {
                message: "unknown field",
                hint: "list keys with GET /v2/spaces/s1/properties",
                see_also: [{ op: "list_properties", params: { space_id: "s1" } }],
              },
            ],
          },
        });

        const [, callToolHandler] = getHandlers(testProxy);
        const result = await callToolHandler({ params: { name: "API-list-properties", arguments: { space_id: "s1" } } });
        const body = JSON.parse(result.content[0].text);

        expect(body.warnings[0].hint).toBe('list keys with API-list-properties {"space_id":"s1"}');
        expect(body.data).toEqual([]);
      });

      it("leaves a download's JSON content alone even when it looks like an envelope", async () => {
        const testProxy = new MCPProxy("test-proxy", specWithOps());
        const content = { warnings: [{ message: "file contents", hint: "GET /v2/spaces", see_also: [{ op: "list_spaces" }] }] };
        (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
          ...mockSuccessResponse,
          data: content,
        });

        const [, callToolHandler] = getHandlers(testProxy);
        const result = await callToolHandler({
          params: { name: "API-download-file", arguments: { space_id: "s", file_id: "f" } },
        });

        expect(JSON.parse(result.content[0].text)).toEqual(content);
      });
    });

    it("preserves structured API failures and marks them as MCP errors", async () => {
      const data = {
        code: "validation_failed",
        message: "Invalid document",
        issues: [{ path: "/name", message: "Required" }],
        hint: "Provide a name",
      };
      // HttpClient is mocked in this suite, including its error constructor.
      const error = Object.assign(new HttpClientError("Bad Request", 400, data), {
        status: 400,
        data,
        requestKey: "retry-1",
      });
      vi.mocked(HttpClient.prototype.executeOperation).mockRejectedValueOnce(error);
      const [, call] = getHandlers(proxy);
      const result = await call({ params: { name: "API-getTest", arguments: {} } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ ...data, status: 400, request_key: "retry-1" });
    });

    it("returns tool input failures without exposing an exception stack", async () => {
      vi.mocked(HttpClient.prototype.executeOperation).mockRejectedValueOnce(
        new Error("Conflicting values for expected_etag"),
      );
      const [, call] = getHandlers(proxy);
      const result = await call({ params: { name: "API-getTest", arguments: {} } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        code: "tool_error",
        message: "Conflicting values for expected_etag",
      });
    });

    it("returns etag and retry metadata without changing successful API data", async () => {
      vi.mocked(HttpClient.prototype.executeOperation).mockResolvedValueOnce({
        ...mockSuccessResponse,
        headers: new Headers({ etag: '"revision"' }),
        requestKey: "retry-1",
      });
      const [, call] = getHandlers(proxy);
      const result = await call({ params: { name: "API-getTest", arguments: {} } });
      expect(result.content.map((item: { text: string }) => JSON.parse(item.text))).toEqual([
        { message: "success" },
        { request_metadata: { etag: '"revision"', request_key: "retry-1" } },
      ]);
    });

    describe("compact write responses", () => {
      const markdown = "Large object content\n".repeat(10000);
      const fullObject = {
        id: "object-1",
        space_id: "space-1",
        name: "Project notes",
        archived: false,
        markdown,
        snippet: markdown.slice(0, 100),
        properties: [{ id: "property-1", text: markdown }],
        icon: { format: "emoji", emoji: "🍅" },
        type: { id: "type-1", key: "page", name: "Page", properties: [{ id: "property-1" }] },
      };
      const identity = {
        id: "object-1",
        space_id: "space-1",
        name: "Project notes",
        archived: false,
        type: { id: "type-1", key: "page", name: "Page" },
      };

      function writeProxy(operationId: string, method: string, path: string) {
        return new MCPProxy(
          "write-test",
          createMockOpenApiSpec({
            paths: { [path]: { [method]: { operationId, responses: { "200": { description: "OK" } } } } },
          }),
        );
      }

      it.each([
        ["create_object", "post", "/v1/spaces/{space_id}/objects"],
        ["update_object", "patch", "/v1/spaces/{space_id}/objects/{object_id}"],
        ["delete_object", "delete", "/v1/spaces/{space_id}/objects/{object_id}"],
        ["create_chat", "post", "/v1/spaces/{space_id}/chats"],
      ])("returns a small receipt for %s without losing write metadata", async (operationId, method, path) => {
        const metadata = {
          warnings: [{ message: "A value was normalized" }],
          issues: [{ path: "/name", message: "Check the name" }],
          created: { properties: [{ id: "generated-property" }] },
          created_blocks: { "ops[0]": "generated-block" },
          created_views: { "ops[1]": "generated-view" },
          diff_stats: { inserted: 1 },
          dry_run: false,
          etag: '"revision"',
        };
        const data = { object: { ...fullObject, ...metadata }, warnings: [{ message: "Envelope warning" }] };
        vi.mocked(HttpClient.prototype.executeOperation).mockResolvedValueOnce({
          ...mockSuccessResponse,
          data,
          headers: new Headers({ etag: '"revision"' }),
          requestKey: "retry-1",
        });
        const [, call] = getHandlers(writeProxy(operationId, method, path));
        const result = await call({ params: { name: `API-${operationId.replaceAll("_", "-")}`, arguments: {} } });
        expect(JSON.parse(result.content[0].text)).toEqual({ ...data, object: { ...identity, ...metadata } });
        expect(JSON.parse(result.content[1].text)).toEqual({
          request_metadata: { etag: '"revision"', request_key: "retry-1" },
        });
        expect(result.content[0].text.length).toBeLessThan(1000);
        expect(data.object.markdown).toBe(markdown);
      });

      it.each([
        ["get_object", "get", "/v1/spaces/{space_id}/objects/{object_id}", { object: fullObject }],
        ["search_space", "post", "/v1/spaces/{space_id}/search", { data: [fullObject] }],
        ["create_object", "post", "/custom/objects", { object: fullObject }],
        ["create_object", "post", "/v1/spaces/{space_id}/objects", { warnings: ["Unexpected response"] }],
        ["create_object", "post", "/v1/spaces/{space_id}/objects", { object: { markdown } }],
        ["create_object", "post", "/v1/spaces/{space_id}/objects", null],
        [
          "create_object",
          "post",
          "/v2/spaces/{space_id}/objects",
          {
            id: "object-1",
            etag: '"revision"',
            type: "page",
            dry_run: false,
            created: { options: [{ id: "option-1" }] },
            warnings: [{ message: "Normalized" }],
          },
        ],
        [
          "patch_object",
          "patch",
          "/v2/spaces/{space_id}/objects/{object_id}",
          { etag: '"revision"', created_blocks: { "ops[0]": "block-1" }, diff_stats: { inserted: 1 }, dry_run: true },
        ],
      ])("preserves %s responses at %s %s", async (operationId, method, path, data) => {
        vi.mocked(HttpClient.prototype.executeOperation).mockResolvedValueOnce({ ...mockSuccessResponse, data });
        const [, call] = getHandlers(writeProxy(operationId, method, path));
        const result = await call({ params: { name: `API-${operationId.replaceAll("_", "-")}`, arguments: {} } });
        expect(JSON.parse(result.content[0].text)).toEqual(data);
      });

      it("preserves a null type and detailed write errors", async () => {
        const [, call] = getHandlers(writeProxy("create_object", "post", "/v1/spaces/{space_id}/objects"));
        const request = { params: { name: "API-create-object", arguments: {} } };
        vi.mocked(HttpClient.prototype.executeOperation).mockResolvedValueOnce({
          ...mockSuccessResponse,
          data: { object: { ...fullObject, type: null } },
        });
        expect(JSON.parse((await call(request)).content[0].text)).toEqual({ object: { ...identity, type: null } });
        const data = { code: "validation_failed", object: fullObject, issues: [{ message: "Invalid content" }] };
        vi.mocked(HttpClient.prototype.executeOperation).mockRejectedValueOnce(
          Object.assign(new HttpClientError("Bad Request", 400, data), { status: 400, data }),
        );
        const result = await call(request);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual({ ...data, status: 400 });
      });
    });

    it("cannot dispatch an excluded event stream", async () => {
      const testProxy = new MCPProxy(
        "test-proxy",
        createMockOpenApiSpec({
          paths: {
            "/stream": {
              get: {
                operationId: "stream",
                responses: { "200": { description: "Stream", content: { "text/event-stream": {} } } },
              },
            },
          },
        }),
      );
      const [list, call] = getHandlers(testProxy);
      expect(await list()).toEqual({ tools: [] });
      await expect(call({ params: { name: "API-stream", arguments: {} } })).rejects.toThrow("not found");
      expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled();
    });

    it("dispatches a long name exactly as advertised", async () => {
      const operationId = "a".repeat(80);
      const testProxy = new MCPProxy(
        "test-proxy",
        createMockOpenApiSpec({
          paths: {
            "/long": { get: { operationId, responses: { "200": { description: "OK" } } } },
          },
        }),
      );
      vi.mocked(HttpClient.prototype.executeOperation).mockResolvedValueOnce(mockSuccessResponse);
      const [list, call] = getHandlers(testProxy);
      const { tools } = await list();
      await call({ params: { name: tools[0].name, arguments: {} } });
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(expect.objectContaining({ operationId }), {});
    });

    it("should handle tool names exceeding 64 characters", async () => {
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccessResponse);

      const longToolName = "a".repeat(65);
      const truncatedToolName = longToolName.slice(0, 64);
      (proxy as any).openApiLookup = {
        [truncatedToolName]: {
          operationId: longToolName,
          responses: { "200": { description: "Success" } },
          method: "get",
          path: "/test",
        },
      };

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: truncatedToolName, arguments: {} } });

      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ message: "success" }) }],
      });
    });
  });

  describe("parseHeadersFromEnv", () => {
    const originalEnv = process.env;
    const expectHeaders = (headers: Record<string, string>) => {
      expect(HttpClient).toHaveBeenCalledWith(expect.objectContaining({ headers }), expect.anything());
    };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should parse valid JSON headers from env", () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
        Authorization: "Bearer token123",
        "X-Custom-Header": "test",
      });
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({ Authorization: "Bearer token123", "X-Custom-Header": "test" });
    });

    it("should return empty object when env var is not set", () => {
      delete process.env.OPENAPI_MCP_HEADERS;
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({});
    });

    it("should return empty object and warn on invalid JSON", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.OPENAPI_MCP_HEADERS = "invalid json";
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({});
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to parse OPENAPI_MCP_HEADERS environment variable:",
        expect.any(Error),
      );
    });

    it("should return empty object and warn on non-object JSON", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.OPENAPI_MCP_HEADERS = '"string"';
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({});
      expect(consoleSpy).toHaveBeenCalledWith(
        "OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:",
        "string",
      );
    });
  });

  describe("base URL integration", () => {
    const originalEnv = process.env;
    const expectBaseUrl = (url: string) => {
      expect(HttpClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: url }), expect.anything());
    };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should use ANYTYPE_API_BASE_URL when set", () => {
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012";
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectBaseUrl("http://localhost:31012");
    });

    it("should use spec servers when env var not set", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectBaseUrl("http://localhost:3000");
    });

    it("should use default when neither env var nor spec servers available", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      new MCPProxy("test-proxy", createMockOpenApiSpec({ servers: undefined }));
      expectBaseUrl("http://127.0.0.1:31009");
    });
  });

  describe("connect", () => {
    it("should connect to transport", async () => {
      const mockTransport = {} as Transport;
      await proxy.connect(mockTransport);

      const server = (proxy as any).server;
      expect(server.connect).toHaveBeenCalledWith(mockTransport);
    });
  });
});
