import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_ENV_KEYS, McpProxyConfig, ProxyConfigEnv } from "../proxy-config.js";

describe("proxy-config utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadConfig(env: ProxyConfigEnv = {}) {
    vi.resetModules();
    BASE_ENV_KEYS.forEach((k) => delete process.env[k]);
    Object.entries(env).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    const { mcpProxyConfig } = await import("../proxy-config.js");
    return mcpProxyConfig;
  }

  // ─── transport ───────────────────────────────────────────────────────────────

  describe("transport", () => {
    it("defaults to stdio", async () => {
      const config = await loadConfig();
      expect(config.transport).toEqual({ type: "stdio" });
    });

    it("stdio when MCP_TRANSPORT is unset", async () => {
      const config = await loadConfig({});
      expect(config.transport.type).toBe("stdio");
    });

    it("http with defaults when MCP_TRANSPORT=http", async () => {
      const config = await loadConfig({ MCP_TRANSPORT: "http" });
      expect(config.transport).toEqual({ type: "http", host: "127.0.0.1", port: 3666 });
    });

    it("http with custom host and port", async () => {
      const config = await loadConfig({ MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0", MCP_PORT: "8080" });
      expect(config.transport).toEqual({ type: "http", host: "0.0.0.0", port: 8080 });
    });

    it("coerces port string to number", async () => {
      const config = await loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: "4000" });
      expect((config.transport as { type: "http"; port: number }).port).toBe(4000);
    });

    it("throws on port below 1024", async () => {
      await expect(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: "80" })).rejects.toThrow();
    });

    it("throws on port above 65535", async () => {
      await expect(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: "99999" })).rejects.toThrow();
    });

    it("throws on non-numeric port", async () => {
      await expect(loadConfig({ MCP_TRANSPORT: "http", MCP_PORT: "not-a-port" })).rejects.toThrow();
    });
  });

  // ─── anytypeApiBaseUrl ────────────────────────────────────────────────────────

  describe("anytypeApiBaseUrl", () => {
    it("is undefined when not set", async () => {
      const config = await loadConfig();
      expect(config.anytypeApiBaseUrl).toBeUndefined();
    });

    it("parses http url and returns origin", async () => {
      const config = await loadConfig({ ANYTYPE_API_BASE_URL: "http://127.0.0.1:31009/some/path" });
      expect(config.anytypeApiBaseUrl).toBe("http://127.0.0.1:31009");
    });

    it("parses https url and returns origin", async () => {
      const config = await loadConfig({ ANYTYPE_API_BASE_URL: "https://api.example.com/v1" });
      expect(config.anytypeApiBaseUrl).toBe("https://api.example.com");
    });

    it("strips path, query, and fragment", async () => {
      const config = await loadConfig({ ANYTYPE_API_BASE_URL: "http://localhost:3000/path?q=1#frag" });
      expect(config.anytypeApiBaseUrl).toBe("http://localhost:3000");
    });

    it("throws on ftp protocol", async () => {
      await expect(loadConfig({ ANYTYPE_API_BASE_URL: "ftp://example.com" })).rejects.toThrow();
    });

    it("throws on ws protocol", async () => {
      await expect(loadConfig({ ANYTYPE_API_BASE_URL: "ws://example.com" })).rejects.toThrow();
    });

    it("throws on invalid url", async () => {
      await expect(loadConfig({ ANYTYPE_API_BASE_URL: "not-a-url" })).rejects.toThrow();
    });
  });

  // ─── headers ─────────────────────────────────────────────────────────────────

  describe("headers", () => {
    it("defaults to empty object", async () => {
      const config = await loadConfig();
      expect(config.openApiHeaders).toEqual({});
    });

    it("parses valid JSON headers", async () => {
      const config = await loadConfig({
        OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: "Bearer token", "Anytype-Version": "1.0" }),
      });
      expect(config.openApiHeaders).toEqual({ Authorization: "Bearer token", "Anytype-Version": "1.0" });
    });

    it("returns empty object on invalid JSON", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const config = await loadConfig({ OPENAPI_MCP_HEADERS: "{not valid json" });
      expect(config.openApiHeaders).toEqual({});
      consoleSpy.mockRestore();
    });

    it("returns empty object when value is non-object JSON", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const config = await loadConfig({ OPENAPI_MCP_HEADERS: '"just-a-string"' });
      expect(config.openApiHeaders).toEqual({});
      consoleSpy.mockRestore();
    });

    it("returns empty object when header values are non-string", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const config = await loadConfig({ OPENAPI_MCP_HEADERS: JSON.stringify({ key: 123 }) });
      expect(config.openApiHeaders).toEqual({});
      consoleSpy.mockRestore();
    });

    it("logs error on parse failure", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await loadConfig({ OPENAPI_MCP_HEADERS: "bad" });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("OPENAPI_MCP_HEADERS"));
      consoleSpy.mockRestore();
    });
  });

  // ─── combined ─────────────────────────────────────────────────────────────────

  describe("combined config", () => {
    it("parses all fields together", async () => {
      const config = await loadConfig({
        MCP_TRANSPORT: "http",
        MCP_HOST: "0.0.0.0",
        MCP_PORT: "8888",
        ANYTYPE_API_BASE_URL: "http://127.0.0.1:31009",
        OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: "Bearer x" }),
      });
      expect(config).toEqual<McpProxyConfig>({
        transport: { type: "http", host: "0.0.0.0", port: 8888 },
        anytypeApiBaseUrl: "http://127.0.0.1:31009",
        openApiHeaders: { Authorization: "Bearer x" },
        passthroughHeaders: ["authorization", "anytype-version"],
      });
    });
  });
});
