import { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { determineBaseUrl, getDefaultSpecUrl, parseEndpointFromEnv } from "../endpoint";

describe("endpoint utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("parseEndpointFromEnv", () => {
    it("should parse valid HTTP URL from env", () => {
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012";
      expect(parseEndpointFromEnv()).toBe("http://localhost:31012");
    });

    it("should parse valid HTTPS URL from env", () => {
      process.env.ANYTYPE_API_BASE_URL = "https://api.example.com:8080";
      expect(parseEndpointFromEnv()).toBe("https://api.example.com:8080");
    });

    it("should strip path from URL and return origin only", () => {
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012/api/v1";
      expect(parseEndpointFromEnv()).toBe("http://localhost:31012");
    });

    it("should return null when env var is not set", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      expect(parseEndpointFromEnv()).toBeNull();
    });

    it("should return null and warn on invalid URL", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.ANYTYPE_API_BASE_URL = "not-a-valid-url";

      expect(parseEndpointFromEnv()).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to parse ANYTYPE_API_BASE_URL environment variable:",
        expect.any(Error),
      );
    });

    it("should return null and warn on unsupported protocol", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.ANYTYPE_API_BASE_URL = "ftp://localhost:31012";

      expect(parseEndpointFromEnv()).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        "ANYTYPE_API_BASE_URL must use http:// or https:// protocol, got: ftp:. Ignoring and using fallback.",
      );
    });
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

    it("should prioritize ANYTYPE_API_BASE_URL over spec servers", () => {
      const consoleSpy = vi.spyOn(console, "error");
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012";

      expect(determineBaseUrl(mockOpenApiSpec)).toBe("http://localhost:31012");
      expect(consoleSpy).toHaveBeenCalledWith("Using base URL from ANYTYPE_API_BASE_URL: http://localhost:31012");
    });

    it("should use spec servers[0].url when env var is not set", () => {
      const consoleSpy = vi.spyOn(console, "error");
      delete process.env.ANYTYPE_API_BASE_URL;

      expect(determineBaseUrl(mockOpenApiSpec)).toBe("http://localhost:3000");
      expect(consoleSpy).toHaveBeenCalledWith("Using base URL from OpenAPI spec: http://localhost:3000");
    });

    it("should use default fallback when neither env var nor spec servers are available", () => {
      const consoleSpy = vi.spyOn(console, "error");
      delete process.env.ANYTYPE_API_BASE_URL;
      const specWithoutServers = {
        ...mockOpenApiSpec,
        servers: undefined,
      };

      expect(determineBaseUrl(specWithoutServers)).toBe("http://127.0.0.1:31009");
      expect(consoleSpy).toHaveBeenCalledWith("Using default base URL: http://127.0.0.1:31009");
    });

    it("should use default fallback when spec is not provided", () => {
      const consoleSpy = vi.spyOn(console, "error");
      delete process.env.ANYTYPE_API_BASE_URL;

      expect(determineBaseUrl()).toBe("http://127.0.0.1:31009");
      expect(consoleSpy).toHaveBeenCalledWith("Using default base URL: http://127.0.0.1:31009");
    });

    it("should fallback to spec servers when env var is invalid", () => {
      const consoleSpy = vi.spyOn(console, "error");
      process.env.ANYTYPE_API_BASE_URL = "invalid-url";

      expect(determineBaseUrl(mockOpenApiSpec)).toBe("http://localhost:3000");
      expect(consoleSpy).toHaveBeenCalledWith("Using base URL from OpenAPI spec: http://localhost:3000");
    });
  });

  describe("getDefaultSpecUrl", () => {
    it("should use ANYTYPE_API_BASE_URL with /docs/openapi.json suffix when set", () => {
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012";
      expect(getDefaultSpecUrl()).toBe("http://localhost:31012/docs/openapi.json");
    });

    it("should strip path from endpoint before adding suffix", () => {
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012/some/path";
      expect(getDefaultSpecUrl()).toBe("http://localhost:31012/docs/openapi.json");
    });

    it("should return default URL when env var is not set", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      expect(getDefaultSpecUrl()).toBe("http://127.0.0.1:31009/docs/openapi.json");
    });

    it("should return default URL when env var is invalid", () => {
      process.env.ANYTYPE_API_BASE_URL = "invalid-url";
      expect(getDefaultSpecUrl()).toBe("http://127.0.0.1:31009/docs/openapi.json");
    });
  });
});
