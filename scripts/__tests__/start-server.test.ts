import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOpenApiSpec, ValidationError } from "../../src/init-server";
import { overrideSpecPath } from "../../src/utils/base-url";

// Reset specPathOverride after each test to avoid inter-test contamination
afterEach(() => overrideSpecPath(undefined));

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
  });

  describe("Local file loading", () => {
    it("should load a valid OpenAPI spec from local file", async () => {
      // Mock fs.readFileSync to return a valid spec
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validOpenApiSpec));
      overrideSpecPath("./test-spec.json");

      const result = await loadOpenApiSpec();

      expect(result).toEqual(validOpenApiSpec);
      expect(fs.readFileSync).toHaveBeenCalledWith(path.resolve(process.cwd(), "./test-spec.json"), "utf-8");
    });

    it("should handle file not found error", async () => {
      // Mock fs.readFileSync to throw ENOENT
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      overrideSpecPath("./non-existent.json");

      // Mock process.exit to prevent actual exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec();

      expect(console.error).toHaveBeenCalledWith("Failed to read OpenAPI specification file:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle invalid JSON", async () => {
      // Mock fs.readFileSync to return invalid JSON
      vi.mocked(fs.readFileSync).mockReturnValue("invalid json");
      overrideSpecPath("./invalid.json");

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec();

      expect(console.error).toHaveBeenCalledWith("Failed to parse OpenAPI specification:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should load a valid OpenAPI spec from local YAML file", async () => {
      // Mock fs.readFileSync to return a valid YAML spec
      const yamlSpec = JSON.stringify(validOpenApiSpec);
      vi.mocked(fs.readFileSync).mockReturnValue(yamlSpec);
      overrideSpecPath("./test-spec.yaml");

      const result = await loadOpenApiSpec();

      expect(result).toEqual(validOpenApiSpec);
      expect(fs.readFileSync).toHaveBeenCalledWith(path.resolve(process.cwd(), "./test-spec.yaml"), "utf-8");
    });

    it("should handle invalid YAML", async () => {
      // Mock fs.readFileSync to return invalid YAML
      vi.mocked(fs.readFileSync).mockReturnValue("invalid: yaml: :");
      overrideSpecPath("./invalid.yaml");

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec();

      expect(console.error).toHaveBeenCalledWith("Failed to parse OpenAPI specification:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("URL loading", () => {
    it("should load a valid OpenAPI spec from URL", async () => {
      // Mock axios.get to return a valid spec
      vi.mocked(axios.get).mockResolvedValue({ data: validOpenApiSpec });
      overrideSpecPath("http://example.com/api-spec.json");

      const result = await loadOpenApiSpec();

      expect(result).toEqual(validOpenApiSpec);
      expect(axios.get).toHaveBeenCalledWith("http://example.com/api-spec.json");
    });

    it("should handle network errors", async () => {
      // Mock axios.get to throw network error
      vi.mocked(axios.get).mockRejectedValue(new Error("Network Error"));
      overrideSpecPath("http://example.com/api-spec.json");

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec();

      expect(console.error).toHaveBeenCalledWith("Failed to fetch OpenAPI specification from URL:", "Network Error");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle invalid response data", async () => {
      // Mock axios.get to return invalid data
      vi.mocked(axios.get).mockResolvedValue({ data: "invalid data" });
      overrideSpecPath("http://example.com/api-spec.json");

      // Mock process.exit
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await loadOpenApiSpec();

      expect(console.error).toHaveBeenCalledWith("Failed to parse OpenAPI specification:", expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should load a valid OpenAPI spec from YAML URL", async () => {
      // Mock axios.get to return a valid YAML spec
      const yamlSpec = JSON.stringify(validOpenApiSpec);
      vi.mocked(axios.get).mockResolvedValue({ data: yamlSpec });
      overrideSpecPath("http://example.com/api-spec.yaml");

      const result = await loadOpenApiSpec();

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
