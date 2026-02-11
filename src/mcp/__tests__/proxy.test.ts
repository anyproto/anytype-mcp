import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Headers } from "node-fetch";
import { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../client/http-client";
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

  describe("getContentType", () => {
    it("should return correct content type for different headers", () => {
      const getContentType = (proxy as any).getContentType.bind(proxy);

      expect(getContentType(new Headers({ "content-type": "text/plain" }))).toBe("text");
      expect(getContentType(new Headers({ "content-type": "application/json" }))).toBe("text");
      expect(getContentType(new Headers({ "content-type": "image/jpeg" }))).toBe("image");
      expect(getContentType(new Headers({ "content-type": "application/octet-stream" }))).toBe("binary");
      expect(getContentType(new Headers())).toBe("binary");
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
