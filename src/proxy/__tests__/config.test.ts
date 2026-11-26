import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL, hasAuthorization, parseHeadersFromEnv, resolveBaseUrl, resolveTier } from "../config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveTier", () => {
  it("defaults to full, the table the OpenAPI-generated tools covered", () => {
    expect(resolveTier(undefined, {})).toBe("full");
  });

  it("takes ANYTYPE_MCP_TIER, and --tier over it", () => {
    expect(resolveTier(undefined, { ANYTYPE_MCP_TIER: "large" })).toBe("large");
    expect(resolveTier("small", { ANYTYPE_MCP_TIER: "large" })).toBe("small");
    expect(resolveTier(" Full ", {})).toBe("full");
  });

  it("refuses an unknown tier, naming where it came from", () => {
    expect(() => resolveTier("huge", {})).toThrow('--tier must be one of small, large, full; got "huge"');
    expect(() => resolveTier(undefined, { ANYTYPE_MCP_TIER: "medium" })).toThrow(/^ANYTYPE_MCP_TIER must be/);
  });
});

describe("parseHeadersFromEnv", () => {
  it("reads the headers every existing install configures", () => {
    const headers = parseHeadersFromEnv({
      OPENAPI_MCP_HEADERS: '{"Authorization":"Bearer k", "Anytype-Version":"2025-11-08"}',
    });

    expect(headers).toEqual({ Authorization: "Bearer k", "Anytype-Version": "2025-11-08" });
    expect(hasAuthorization(headers)).toBe(true);
  });

  it("drops headers the transport owns", () => {
    const warn = vi.fn();

    const headers = parseHeadersFromEnv(
      { OPENAPI_MCP_HEADERS: '{"authorization":"Bearer k","Content-Type":"text/plain","Mcp-Session-Id":"x"}' },
      warn,
    );

    expect(headers).toEqual({ authorization: "Bearer k" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not JSON", "{oops", /not valid JSON/],
    ["an array", "[1]", /must be a JSON object/],
  ])("ignores a value that is %s, with a warning", (_, value, message) => {
    const warn = vi.fn();

    expect(parseHeadersFromEnv({ OPENAPI_MCP_HEADERS: value }, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(message));
  });

  it("is empty without the variable", () => {
    expect(parseHeadersFromEnv({})).toEqual({});
    expect(hasAuthorization({})).toBe(false);
  });
});

describe("resolveBaseUrl", () => {
  it("uses ANYTYPE_API_BASE_URL's origin, else the desktop default", () => {
    vi.stubEnv("ANYTYPE_API_BASE_URL", "");
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);

    vi.stubEnv("ANYTYPE_API_BASE_URL", "http://localhost:31012/ignored/path");
    expect(resolveBaseUrl()).toBe("http://localhost:31012");
  });
});
