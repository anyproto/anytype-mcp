import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startStdioProxy = vi.fn((_options: Record<string, unknown>) => ({
  closed: new Promise<void>(() => {}),
  abort: vi.fn(async () => {}),
}));

vi.mock("../proxy/stdio-proxy", () => ({ startStdioProxy }));

const { main, parseArgs } = await import("../cli");

const SECRET = "sk-SENTINEL-42";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "once").mockImplementation((() => process) as any);
  vi.stubEnv("OPENAPI_MCP_HEADERS", '{"Authorization":"Bearer k"}');
  vi.stubEnv("ANYTYPE_API_BASE_URL", "");
  vi.stubEnv("ANYTYPE_MCP_TIER", "");
  vi.stubEnv("ANYTYPE_MCP_FILES_DIR", "/tmp/anytype-mcp-cli-test");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const started = () => startStdioProxy.mock.calls[0][0];

describe("parseArgs", () => {
  it("separates --tier in both spellings from positional arguments", () => {
    expect(parseArgs(["run", "--tier", "large"])).toEqual({ positional: ["run"], tier: "large" });
    expect(parseArgs(["--tier=small"])).toEqual({ positional: [], tier: "small" });
  });
});

describe("main", () => {
  it.each([[[]], [["run"]]])("proxies to /mcp/full with the configured key for %j", async (args) => {
    await main(args);

    expect(started()).toMatchObject({
      baseUrl: "http://127.0.0.1:31009",
      tier: "full",
      headers: { Authorization: "Bearer k" },
      filesDir: "/tmp/anytype-mcp-cli-test",
    });
    expect(started().configError).toBeUndefined();
  });

  it("selects the tier from --tier, then ANYTYPE_MCP_TIER", async () => {
    vi.stubEnv("ANYTYPE_MCP_TIER", "small");
    await main([]);
    await main(["--tier", "large"]);

    expect(startStdioProxy.mock.calls.map((call) => call[0].tier)).toEqual(["small", "large"]);
  });

  it.each([
    ["an unknown tier", ["--tier", "huge"], {}, /--tier must be one of small, large, full/],
    ["--tier without a value", ["--tier"], {}, /--tier needs a value/],
    [
      "a spec argument from version 2",
      ["run", "http://127.0.0.1:31009/v1/docs/openapi.json"],
      {},
      /no longer generates tools.*@2\.0\.3/,
    ],
    ["an unusable base URL", [], { ANYTYPE_API_BASE_URL: "ftp://x" }, /ANYTYPE_API_BASE_URL/],
    [
      "a malformed key",
      [],
      { OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: `Bearer ${SECRET}\nX` }) },
      /value of Authorization/,
    ],
  ])("serves %s as an error the host shows, instead of exiting", async (_, args, env, message) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value as string);

    await main(args as string[]);

    expect(started().configError).toMatch(message);
    const printed = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(printed).not.toContain(SECRET);
    expect(String(started().configError)).not.toContain(SECRET);
  });

  it("exits on an unknown command", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    await main(["unknown"]);

    expect(exit).toHaveBeenCalledWith(1);
  });
});
