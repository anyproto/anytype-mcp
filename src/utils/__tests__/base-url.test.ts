import { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_ENV_KEYS, ProxyConfigEnv } from "../proxy-config.js";

describe("base-url utilities", () => {
  const originalEnv = process.env;

  async function loadBaseUrl(env: ProxyConfigEnv = {}) {
    vi.resetModules();
    BASE_ENV_KEYS.forEach((k) => delete process.env[k]);
    Object.entries(env).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    return import("../base-url.js");
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("determineBaseUrl", () => {
    const mockOpenApiSpec: OpenAPIV3.Document = {
      openapi: "3.0.0",
      servers: [{ url: "http://localhost:3000" }],
      info: {
        title: "Test API",
        version: "1.0.0",
      },
      paths: {},
    };

    it("should prioritize ANYTYPE_API_BASE_URL over spec servers", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { determineBaseUrl } = await loadBaseUrl({ ANYTYPE_API_BASE_URL: "http://localhost:31012" });

      expect(determineBaseUrl(mockOpenApiSpec)).toBe("http://localhost:31012");
      expect(consoleSpy).toHaveBeenCalledWith("Using base URL from ANYTYPE_API_BASE_URL: http://localhost:31012");
      consoleSpy.mockRestore();
    });

    it("should use spec servers[0].url when env var is not set", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { determineBaseUrl } = await loadBaseUrl();

      expect(determineBaseUrl(mockOpenApiSpec)).toBe("http://localhost:3000");
      expect(consoleSpy).toHaveBeenCalledWith("Using base URL from OpenAPI spec: http://localhost:3000");
      consoleSpy.mockRestore();
    });

    it("should use default fallback when neither env var nor spec servers are available", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { determineBaseUrl } = await loadBaseUrl();

      expect(determineBaseUrl({ ...mockOpenApiSpec, servers: undefined })).toBe("http://127.0.0.1:31009");
      expect(consoleSpy).toHaveBeenCalledWith("Using default base URL: http://127.0.0.1:31009");
      consoleSpy.mockRestore();
    });

    it("should use default fallback when spec is not provided", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { determineBaseUrl } = await loadBaseUrl();

      expect(determineBaseUrl()).toBe("http://127.0.0.1:31009");
      expect(consoleSpy).toHaveBeenCalledWith("Using default base URL: http://127.0.0.1:31009");
      consoleSpy.mockRestore();
    });

    it("should strip path from ANYTYPE_API_BASE_URL, keeping origin only", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { determineBaseUrl } = await loadBaseUrl({ ANYTYPE_API_BASE_URL: "http://localhost:31012/some/path" });

      expect(determineBaseUrl(mockOpenApiSpec)).toBe("http://localhost:31012");
      consoleSpy.mockRestore();
    });
  });

  describe("getDefaultSpecUrl", () => {
    it("should use ANYTYPE_API_BASE_URL with /docs/openapi.json suffix when set", async () => {
      const { getDefaultSpecUrl } = await loadBaseUrl({ ANYTYPE_API_BASE_URL: "http://localhost:31012" });
      expect(getDefaultSpecUrl()).toBe("http://localhost:31012/docs/openapi.json");
    });

    it("should strip path from endpoint before adding suffix", async () => {
      const { getDefaultSpecUrl } = await loadBaseUrl({ ANYTYPE_API_BASE_URL: "http://localhost:31012/some/path" });
      expect(getDefaultSpecUrl()).toBe("http://localhost:31012/docs/openapi.json");
    });

    it("should return default URL when env var is not set", async () => {
      const { getDefaultSpecUrl } = await loadBaseUrl();
      expect(getDefaultSpecUrl()).toBe("http://127.0.0.1:31009/docs/openapi.json");
    });
  });
});
