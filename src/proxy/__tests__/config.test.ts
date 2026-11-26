import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_BASE_URL,
  loadConfig,
  parseHeaders,
  resolveBaseUrl,
  resolveFilesDir,
  resolveTier,
} from "../config";

const SECRET = "sk-SENTINEL-0123456789";

function configError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("resolveTier", () => {
  it("defaults to full, takes ANYTYPE_MCP_TIER, and --tier over it", () => {
    expect(resolveTier(undefined, {})).toBe("full");
    expect(resolveTier(undefined, { ANYTYPE_MCP_TIER: "large" })).toBe("large");
    expect(resolveTier("small", { ANYTYPE_MCP_TIER: "large" })).toBe("small");
    expect(resolveTier(" Full ", {})).toBe("full");
  });

  it("refuses an unknown tier, naming where it came from", () => {
    expect(configError(() => resolveTier("huge", {}))).toBe('--tier must be one of small, large, full; got "huge"');
    expect(configError(() => resolveTier(undefined, { ANYTYPE_MCP_TIER: "medium" }))).toMatch(
      /^ANYTYPE_MCP_TIER must be/,
    );
  });
});

describe("parseHeaders", () => {
  it("reads the headers every existing install configures", () => {
    expect(
      parseHeaders({ OPENAPI_MCP_HEADERS: '{"Authorization":"Bearer k", "Anytype-Version":"2025-11-08"}' }),
    ).toEqual({
      Authorization: "Bearer k",
      "Anytype-Version": "2025-11-08",
    });
  });

  it("drops headers the transport owns, with a warning", () => {
    const warnings: string[] = [];
    expect(parseHeaders({ OPENAPI_MCP_HEADERS: '{"authorization":"Bearer k","Content-Type":"x"}' }, warnings)).toEqual({
      authorization: "Bearer k",
    });
    expect(warnings).toEqual([expect.stringMatching(/ignoring Content-Type/)]);
  });

  it.each([
    ["If-Match", /if_match/],
    ["Idempotency-Key", /idempotency_key/],
    ["Range", /whole file/],
    ["If-None-Match", /one request/],
  ])("refuses the request-scoped %s instead of silently dropping it", (name, hint) => {
    const message = configError(() =>
      parseHeaders({ OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: "Bearer k", [name]: "v" }) }),
    );
    expect(message).toMatch(new RegExp(`sets ${name}`));
    expect(message).toMatch(hint);
  });

  it.each([
    ["a line break in the key", { Authorization: `Bearer ${SECRET}\nX` }],
    ["a NUL in the key", { Authorization: `Bearer ${SECRET}\u0000` }],
    ["JSON the parser cannot read", `{"Authorization":"Bearer ${SECRET}"`],
    ["a key that became a header name", { [`Bearer ${SECRET}`]: "" }],
    ["a non-string value", { Authorization: { token: SECRET } }],
  ])("reports %s without quoting the key", (_, value) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const message = configError(() => parseHeaders({ OPENAPI_MCP_HEADERS: raw }));
    expect(message).not.toContain(SECRET);
    expect(message).toMatch(/OPENAPI_MCP_HEADERS/);
  });

  it("names the header whose value is malformed", () => {
    expect(
      configError(() => parseHeaders({ OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: "Bearer a\nb" }) })),
    ).toMatch(/the value of Authorization is not a valid HTTP header value/);
  });
});

describe("resolveBaseUrl", () => {
  it("uses ANYTYPE_API_BASE_URL's origin, else the desktop default", () => {
    expect(resolveBaseUrl({})).toBe(DEFAULT_BASE_URL);
    expect(resolveBaseUrl({ ANYTYPE_API_BASE_URL: "  " })).toBe(DEFAULT_BASE_URL);
    expect(resolveBaseUrl({ ANYTYPE_API_BASE_URL: "http://localhost:31012/ignored/path" })).toBe(
      "http://localhost:31012",
    );
  });

  it("refuses a set but unusable value rather than sending the key to the default port", () => {
    expect(configError(() => resolveBaseUrl({ ANYTYPE_API_BASE_URL: "htp:/broken" }))).toMatch(
      /http:\/\/ or https:\/\//,
    );
    expect(configError(() => resolveBaseUrl({ ANYTYPE_API_BASE_URL: "not a url" }))).toMatch(/not a URL/);
  });
});

describe("resolveFilesDir", () => {
  it("defaults to ~/.anytype-mcp/files and expands ~ in ANYTYPE_MCP_FILES_DIR", () => {
    expect(resolveFilesDir({})).toBe(join(homedir(), ".anytype-mcp", "files"));
    expect(resolveFilesDir({ ANYTYPE_MCP_FILES_DIR: "~/AI files" })).toBe(join(homedir(), "AI files"));
  });

  it("refuses a relative directory", () => {
    expect(configError(() => resolveFilesDir({ ANYTYPE_MCP_FILES_DIR: "files" }))).toMatch(/absolute path/);
  });
});

describe("loadConfig", () => {
  it("collects everything and warns about a missing key", () => {
    const config = loadConfig(undefined, {});
    expect(config).toMatchObject({ baseUrl: DEFAULT_BASE_URL, tier: "full", headers: {} });
    expect(config.warnings.join()).toMatch(/no "Authorization"/);
  });
});
