import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOpenApiSpec, ValidationError } from "../../src/init-server";

// Mock fs and axios
vi.mock("node:fs");
vi.mock("axios");
vi.mock("@modelcontextprotocol/sdk/server/stdio.js");

// Create a mock Server class with proper prototype methods
const mockSetRequestHandler = vi.fn();
const mockConnect = vi.fn();

function createMockServer(info: any, options: any) {
  const server = {
    info,
    options,
  };

  Object.defineProperty(server, "setRequestHandler", {
    value: mockSetRequestHandler,
    writable: false,
    configurable: true,
  });

  Object.defineProperty(server, "connect", {
    value: mockConnect,
    writable: false,
    configurable: true,
  });

  return server;
}

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn().mockImplementation((info, options) => createMockServer(info, options)),
}));

const validOpenApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Test API",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000" }],
  paths: {
    "/pets": {
      get: {
        operationId: "getPets",
        responses: {
          "200": { description: "A list of pets" },
        },
      },
    },
  },
};

describe("loadOpenApiSpec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset console.error to capture output
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  describe("automatic API selection", () => {
    beforeEach(() => {
      vi.stubEnv("ANYTYPE_API_BASE_URL", "");
    });

    it("prefers v2 even when the default endpoint may still serve v1", async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({ data: validOpenApiSpec });

      expect(await loadOpenApiSpec()).toEqual(validOpenApiSpec);
      expect(axios.get).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:31009/v2/docs/openapi.json");
    });

    it.each([404, 410])("loads the legacy spec at the server root when v2 returns %s", async (status) => {
      const legacySpec = {
        ...validOpenApiSpec,
        paths: { "/spaces": validOpenApiSpec.paths["/pets"] },
      };
      vi.mocked(axios.get)
        .mockRejectedValueOnce({ response: { status } })
        .mockResolvedValueOnce({ data: JSON.stringify(legacySpec) });

      expect(await loadOpenApiSpec()).toEqual(legacySpec);
      expect(vi.mocked(axios.get).mock.calls).toEqual([
        ["http://127.0.0.1:31009/v2/docs/openapi.json"],
        ["http://127.0.0.1:31009/docs/openapi.json"],
      ]);
      expect(console.error).toHaveBeenCalledWith(
        "v2 OpenAPI endpoint unavailable; falling back to /docs/openapi.json.",
      );
    });

    it("uses the configured server for both probes", async () => {
      vi.stubEnv("ANYTYPE_API_BASE_URL", "https://api.example.com:31012/some/path");
      vi.mocked(axios.get)
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockResolvedValueOnce({ data: validOpenApiSpec });

      expect(await loadOpenApiSpec()).toEqual(validOpenApiSpec);
      expect(vi.mocked(axios.get).mock.calls).toEqual([
        ["https://api.example.com:31012/v2/docs/openapi.json"],
        ["https://api.example.com:31012/docs/openapi.json"],
      ]);
    });

    it.each([401, 403, 429, 500, 503])("does not fall back on HTTP %s", async (status) => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
      vi.mocked(axios.get).mockRejectedValueOnce({ response: { status }, message: "Request failed" });

      await loadOpenApiSpec();

      expect(exit).toHaveBeenCalledWith(1);
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it.each(["ECONNREFUSED", "ETIMEDOUT"])("does not fall back on %s", async (code) => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
      vi.mocked(axios.get).mockRejectedValueOnce({ code, message: "Network error" });

      await loadOpenApiSpec();

      expect(exit).toHaveBeenCalledWith(1);
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it("reports invalid v2 JSON without falling back", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
      vi.mocked(axios.get).mockResolvedValueOnce({ data: "invalid JSON" });

      await loadOpenApiSpec();

      expect(exit).toHaveBeenCalledWith(1);
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith("Failed to parse OpenAPI specification:", expect.any(String));
    });

    it("reports a failed fallback without further probes", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
      vi.mocked(axios.get)
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockRejectedValueOnce({ response: { status: 404 }, message: "Legacy spec missing" });

      await loadOpenApiSpec();

      expect(exit).toHaveBeenCalledWith(1);
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenCalledWith(
        "Failed to fetch OpenAPI specification from URL:",
        "Legacy spec missing",
      );
    });

    it.each(["/v1/docs/openapi.json", "/v2/docs/openapi.json", "/docs/openapi.json"])(
      "keeps an explicitly selected %s pinned, even when missing",
      async (path) => {
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        vi.mocked(axios.get).mockRejectedValueOnce({ response: { status: 404 }, message: "Not found" });
        const url = `http://127.0.0.1:31009${path}`;

        await loadOpenApiSpec(url);

        expect(exit).toHaveBeenCalledWith(1);
        expect(axios.get).toHaveBeenCalledExactlyOnceWith(url);
      },
    );
  });

  describe("Local file loading", () => {
    it("should load a valid OpenAPI spec from local file", async () => {
      // Mock fs.readFileSync to return a valid spec
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validOpenApiSpec));

      const result = await loadOpenApiSpec("./test-spec.json");

      expect(result).toEqual(validOpenApiSpec);
      expect(fs.readFileSync).toHaveBeenCalledWith(path.resolve(process.cwd(), "./test-spec.json"), "utf-8");
    });

    it("should handle file not found error", async () => {
      // Mock fs.readFileSync to throw ENOENT
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      // Mock process.exit to prevent actual exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec("./non-existent.json");

      expect(console.error).toHaveBeenCalledWith("Failed to read OpenAPI specification file:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle invalid JSON", async () => {
      // Mock fs.readFileSync to return invalid JSON
      vi.mocked(fs.readFileSync).mockReturnValue("invalid json");

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec("./invalid.json");

      expect(console.error).toHaveBeenCalledWith("Failed to parse OpenAPI specification:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should load a valid OpenAPI spec from local YAML file", async () => {
      // Mock fs.readFileSync to return a valid YAML spec
      const yamlSpec = JSON.stringify(validOpenApiSpec);
      vi.mocked(fs.readFileSync).mockReturnValue(yamlSpec);

      const result = await loadOpenApiSpec("./test-spec.yaml");

      expect(result).toEqual(validOpenApiSpec);
      expect(fs.readFileSync).toHaveBeenCalledWith(path.resolve(process.cwd(), "./test-spec.yaml"), "utf-8");
    });

    it("should handle invalid YAML", async () => {
      // Mock fs.readFileSync to return invalid YAML
      vi.mocked(fs.readFileSync).mockReturnValue("invalid: yaml: :");

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec("./invalid.yaml");

      expect(console.error).toHaveBeenCalledWith("Failed to parse OpenAPI specification:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("URL loading", () => {
    it("should load a valid OpenAPI spec from URL", async () => {
      // Mock axios.get to return a valid spec
      vi.mocked(axios.get).mockResolvedValue({ data: validOpenApiSpec });

      const result = await loadOpenApiSpec("http://example.com/api-spec.json");

      expect(result).toEqual(validOpenApiSpec);
      expect(axios.get).toHaveBeenCalledWith("http://example.com/api-spec.json");
    });

    it("should handle network errors", async () => {
      // Mock axios.get to throw network error
      vi.mocked(axios.get).mockRejectedValue(new Error("Network Error"));

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec("http://example.com/api-spec.json");

      expect(console.error).toHaveBeenCalledWith("Failed to fetch OpenAPI specification from URL:", "Network Error");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle invalid response data", async () => {
      // Mock axios.get to return invalid data
      vi.mocked(axios.get).mockResolvedValue({ data: "invalid data" });

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec("http://example.com/api-spec.json");

      expect(console.error).toHaveBeenCalledWith("Failed to parse OpenAPI specification:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should load a valid OpenAPI spec from YAML URL", async () => {
      // Mock axios.get to return a valid YAML spec
      const yamlSpec = JSON.stringify(validOpenApiSpec);
      vi.mocked(axios.get).mockResolvedValue({ data: yamlSpec });

      const result = await loadOpenApiSpec("http://example.com/api-spec.yaml");

      expect(result).toEqual(validOpenApiSpec);
      expect(axios.get).toHaveBeenCalledWith("http://example.com/api-spec.yaml");
    });
  });
});

describe("main", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should run the server when being called without a command", async () => {
    vi.resetModules();
    vi.doMock("../../src/init-server", () => ({
      initProxy: vi.fn().mockResolvedValue(undefined),
      loadOpenApiSpec: vi.fn().mockResolvedValue(validOpenApiSpec),
      ValidationError: class ValidationError extends Error {
        errors: any[];
        constructor(errors: any[]) {
          super("OpenAPI validation failed");
          this.name = "ValidationError";
          this.errors = errors;
        }
      },
    }));

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    const { main } = await import("../start-server");
    await main([]);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("should error on unknown command", async () => {
    vi.resetModules();
    vi.doMock("../../src/init-server", () => ({
      initProxy: vi.fn().mockResolvedValue(undefined),
      loadOpenApiSpec: vi.fn().mockResolvedValue(validOpenApiSpec),
      ValidationError: class ValidationError extends Error {
        errors: any[];
        constructor(errors: any[]) {
          super("OpenAPI validation failed");
          this.name = "ValidationError";
          this.errors = errors;
        }
      },
    }));

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    const { main } = await import("../start-server");
    await main(["unknown"]);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe("ValidationError", () => {
  it("should create error with validation details", () => {
    const errors = [{ message: "Missing required field" }];
    const error = new ValidationError(errors);

    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("OpenAPI validation failed");
    expect(error.errors).toEqual(errors);
  });
});
