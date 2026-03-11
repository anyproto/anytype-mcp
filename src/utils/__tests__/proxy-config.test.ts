import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config, ConfigEnv, ENV_KEYS } from "../config.js";

describe("proxy-config utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadConfig(env: ConfigEnv = {}) {
    vi.resetModules();
    ENV_KEYS.forEach((k) => delete process.env[k]);
    Object.entries(env).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    const { getConfig } = await import("../config.js");
    return getConfig();
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
      expect(config.transport).toEqual({
        type: "http",
        host: "127.0.0.1",
        port: 3666,
        passthroughHeaders: ["authorization", "anytype-version"],
      });
    });

    it("http with custom host and port", async () => {
      const config = await loadConfig({ MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0", MCP_PORT: "8080" });
      expect(config.transport).toEqual({
        type: "http",
        host: "0.0.0.0",
        port: 8080,
        passthroughHeaders: ["authorization", "anytype-version"],
      });
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

  // ─── httpClient.baseUrl ───────────────────────────────────────────────────────

  describe("httpClient.baseUrl", () => {
    it("is undefined when not set", async () => {
      const config = await loadConfig();
      expect(config.httpClient.baseUrl).toBeUndefined();
    });

    it("parses http url and returns origin", async () => {
      const config = await loadConfig({ ANYTYPE_API_BASE_URL: "http://127.0.0.1:31009/some/path" });
      expect(config.httpClient.baseUrl).toBe("http://127.0.0.1:31009");
    });

    it("parses https url and returns origin", async () => {
      const config = await loadConfig({ ANYTYPE_API_BASE_URL: "https://api.example.com/v1" });
      expect(config.httpClient.baseUrl).toBe("https://api.example.com");
    });

    it("strips path, query, and fragment", async () => {
      const config = await loadConfig({ ANYTYPE_API_BASE_URL: "http://localhost:3000/path?q=1#frag" });
      expect(config.httpClient.baseUrl).toBe("http://localhost:3000");
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

  // ─── httpClient.headers ───────────────────────────────────────────────────────

  describe("httpClient.headers", () => {
    it("defaults to empty object", async () => {
      const config = await loadConfig();
      expect(config.httpClient.headers).toEqual({});
    });

    it("parses valid JSON headers", async () => {
      const config = await loadConfig({
        OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: "Bearer token", "Anytype-Version": "1.0" }),
      });
      expect(config.httpClient.headers).toEqual({ Authorization: "Bearer token", "Anytype-Version": "1.0" });
    });

    it("returns empty object on invalid JSON", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const config = await loadConfig({ OPENAPI_MCP_HEADERS: "{not valid json" });
      expect(config.httpClient.headers).toEqual({});
      consoleSpy.mockRestore();
    });

    it("returns empty object when value is non-object JSON", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const config = await loadConfig({ OPENAPI_MCP_HEADERS: '"just-a-string"' });
      expect(config.httpClient.headers).toEqual({});
      consoleSpy.mockRestore();
    });

    it("returns empty object when header values are non-string", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const config = await loadConfig({ OPENAPI_MCP_HEADERS: JSON.stringify({ key: 123 }) });
      expect(config.httpClient.headers).toEqual({});
      consoleSpy.mockRestore();
    });

    it("logs error on parse failure", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await loadConfig({ OPENAPI_MCP_HEADERS: "bad" });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("OPENAPI_MCP_HEADERS"));
      consoleSpy.mockRestore();
    });
  });

  // ─── transport.passthroughHeaders ────────────────────────────────────────────

  describe("transport.passthroughHeaders (http only)", () => {
    it("defaults to DEFAULT_PASSTHROUGH_HEADERS", async () => {
      const config = await loadConfig({ MCP_TRANSPORT: "http" });
      expect((config.transport as { type: "http"; passthroughHeaders: string[] }).passthroughHeaders).toEqual([
        "authorization",
        "anytype-version",
      ]);
    });

    it("parses custom comma-separated headers", async () => {
      const config = await loadConfig({ MCP_TRANSPORT: "http", MCP_PASSTHROUGH_HEADERS: "x-custom, x-other" });
      expect((config.transport as { type: "http"; passthroughHeaders: string[] }).passthroughHeaders).toEqual([
        "x-custom",
        "x-other",
      ]);
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
      expect(config).toEqual<Config>({
        transport: {
          type: "http",
          host: "0.0.0.0",
          port: 8888,
          passthroughHeaders: ["authorization", "anytype-version"],
        },
        httpClient: { baseUrl: "http://127.0.0.1:31009", headers: { Authorization: "Bearer x" } },
      });
    });
  });
});
