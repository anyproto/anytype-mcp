import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startStdioProxy = vi.fn(() => ({ closed: new Promise<void>(() => {}), close: vi.fn(async () => {}) }));
const initProxy = vi.fn(async () => {});

vi.mock("../proxy/stdio-proxy", () => ({ startStdioProxy }));
vi.mock("../legacy/init-server", () => ({
  initProxy,
  loadOpenApiSpec: vi.fn(),
  ValidationError: class extends Error {},
}));

const { main, parseArgs } = await import("../cli");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "once").mockImplementation((() => process) as any);
  vi.stubEnv("OPENAPI_MCP_HEADERS", '{"Authorization":"Bearer k"}');
  vi.stubEnv("ANYTYPE_API_BASE_URL", "");
  vi.stubEnv("ANYTYPE_MCP_TIER", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseArgs", () => {
  it("separates --tier in both spellings from positional arguments", () => {
    expect(parseArgs(["run", "--tier", "large"])).toEqual({ positional: ["run"], tier: "large" });
    expect(parseArgs(["--tier=small"])).toEqual({ positional: [], tier: "small" });
    expect(parseArgs(["run", "spec.json"])).toEqual({ positional: ["run", "spec.json"], tier: undefined });
  });

  it("refuses --tier without a value", () => {
    expect(() => parseArgs(["--tier"])).toThrow(/--tier needs a value/);
  });
});

describe("main", () => {
  it.each([[[]], [["run"]]])("proxies to /mcp/full with the configured key for %j", async (args) => {
    await main(args);

    expect(startStdioProxy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:31009",
        tier: "full",
        headers: { Authorization: "Bearer k" },
        legacyFallback: expect.any(Function),
      }),
    );
    expect(initProxy).not.toHaveBeenCalled();
  });

  it("selects the tier from --tier, then ANYTYPE_MCP_TIER", async () => {
    vi.stubEnv("ANYTYPE_MCP_TIER", "small");
    await main([]);
    await main(["--tier", "large"]);

    expect(startStdioProxy.mock.calls.map((call: any[]) => call[0].tier)).toEqual(["small", "large"]);
  });

  it("serves the tools generated from a spec that is named explicitly", async () => {
    await main(["run", "http://127.0.0.1:31009/v1/docs/openapi.json"]);

    expect(initProxy).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:31009/v1/docs/openapi.json");
    expect(startStdioProxy).not.toHaveBeenCalled();
  });

  it("warns when no key is configured", async () => {
    vi.stubEnv("OPENAPI_MCP_HEADERS", "");

    await main([]);

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/no "Authorization": "Bearer <key>" entry/));
  });

  it("refuses an unknown tier before starting anything", async () => {
    await expect(main(["--tier", "huge"])).rejects.toThrow(/--tier must be one of small, large, full/);
    expect(startStdioProxy).not.toHaveBeenCalled();
  });

  it("exits on an unknown command", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    await main(["unknown"]);

    expect(exit).toHaveBeenCalledWith(1);
  });
});
