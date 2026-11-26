import { parseBaseUrlFromEnv } from "../utils/base-url";

/** The tool tables Anytype's built-in MCP server serves at /mcp/{tier}. */
export const TIERS = ["small", "large", "full"] as const;
export type Tier = (typeof TIERS)[number];

/** `full` is the table derived from the whole API, the one this package served before. */
export const DEFAULT_TIER: Tier = "full";
export const DEFAULT_BASE_URL = "http://127.0.0.1:31009";

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/**
 * The tier from `--tier`, else ANYTYPE_MCP_TIER, else `full`. An unknown name is
 * an error rather than a silent default: the tiers serve different tools.
 */
export function resolveTier(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): Tier {
  const [value, source] = flag !== undefined ? [flag, "--tier"] : [env.ANYTYPE_MCP_TIER, "ANYTYPE_MCP_TIER"];
  if (value === undefined || value === "") return DEFAULT_TIER;
  const tier = value.trim().toLowerCase();
  if (!isTier(tier)) {
    throw new Error(`${source} must be one of ${TIERS.join(", ")}; got "${value}"`);
  }
  return tier;
}

/** ANYTYPE_API_BASE_URL's origin, else the desktop app's default address. */
export function resolveBaseUrl(): string {
  return parseBaseUrlFromEnv() ?? DEFAULT_BASE_URL;
}

/**
 * Headers the proxy owns on every request. A user header with one of these
 * names would break the transport, so it is dropped (case-insensitively).
 */
const transportHeaders = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

/**
 * OPENAPI_MCP_HEADERS, the configuration every existing install carries: a JSON
 * object such as {"Authorization":"Bearer <key>","Anytype-Version":"2025-11-08"}.
 * Authorization is what matters to /mcp; other headers are passed along as before.
 */
export function parseHeadersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.error(message),
): Record<string, string> {
  const raw = env.OPENAPI_MCP_HEADERS;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(`OPENAPI_MCP_HEADERS is not valid JSON and is ignored: ${error instanceof Error ? error.message : error}`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn("OPENAPI_MCP_HEADERS must be a JSON object of header names to values; it is ignored");
    return {};
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) continue;
    if (transportHeaders.has(name.toLowerCase())) {
      warn(`OPENAPI_MCP_HEADERS: ignoring ${name}, which the MCP transport sets itself`);
      continue;
    }
    headers[name] = String(value);
  }
  return headers;
}

/** True when the headers carry an Authorization value, in any spelling. */
export function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}
