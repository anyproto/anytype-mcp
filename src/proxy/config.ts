import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The tool tables Anytype's built-in MCP server serves at /mcp/{tier}. */
export const TIERS = ["small", "large", "full"] as const;
export type Tier = (typeof TIERS)[number];

/** `full` is the table derived from the whole API, the one this package served before. */
export const DEFAULT_TIER: Tier = "full";
export const DEFAULT_BASE_URL = "http://127.0.0.1:31009";

/**
 * A configuration the proxy cannot run with. Its message is shown to the user
 * and never contains a header value: those carry the API key.
 */
export class ConfigError extends Error {}

export interface Config {
  baseUrl: string;
  tier: Tier;
  headers: Record<string, string>;
  /** The one directory the local file tools read from and write to. */
  filesDir: string;
  /** Problems worth a line on stderr that do not stop the proxy. */
  warnings: string[];
}

export function loadConfig(tierFlag: string | undefined, env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];
  const headers = parseHeaders(env, warnings);
  if (!hasAuthorization(headers)) {
    warnings.push(
      'OPENAPI_MCP_HEADERS has no "Authorization": "Bearer <key>" entry; Anytype will refuse every call. ' +
        "Create a key in Anytype → Settings → API keys, or run `anytype-mcp get-key`.",
    );
  }
  return {
    baseUrl: resolveBaseUrl(env),
    tier: resolveTier(tierFlag, env),
    headers,
    filesDir: resolveFilesDir(env),
    warnings,
  };
}

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/**
 * The tier from `--tier`, else ANYTYPE_MCP_TIER, else `full`. An unknown name is
 * an error rather than a silent default: the tiers serve different tools.
 */
export function resolveTier(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): Tier {
  // an empty --tier= is a mistake (often an unset variable a launcher expanded), not a request for the default
  if (flag !== undefined && flag.trim() === "") throw new ConfigError("--tier needs a value: small, large or full");
  const [value, source] = flag !== undefined ? [flag, "--tier"] : [env.ANYTYPE_MCP_TIER, "ANYTYPE_MCP_TIER"];
  if (value === undefined || value.trim() === "") return DEFAULT_TIER;
  const tier = value.trim().toLowerCase();
  if (!isTier(tier)) throw new ConfigError(`${source} must be one of ${TIERS.join(", ")}; got "${value}"`);
  return tier;
}

/**
 * ANYTYPE_API_BASE_URL's origin, else the desktop app's address. A value that
 * is set but unusable is an error: falling back would send the key meant for
 * that server to whatever listens on the default port.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ANYTYPE_API_BASE_URL?.trim();
  if (!value) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      "ANYTYPE_API_BASE_URL is not a URL; set it to Anytype's address, e.g. http://127.0.0.1:31012",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("ANYTYPE_API_BASE_URL must start with http:// or https://");
  }
  return url.origin;
}

/** ANYTYPE_MCP_FILES_DIR, else ~/.anytype-mcp/files. */
export function resolveFilesDir(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ANYTYPE_MCP_FILES_DIR?.trim();
  if (!value) return join(homedir(), ".anytype-mcp", "files");
  const dir = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
  if (!isAbsolute(dir)) throw new ConfigError("ANYTYPE_MCP_FILES_DIR must be an absolute path");
  return dir;
}

/** Headers the proxy sets itself on every request; a configured one is dropped. */
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
 * Headers that belong to one request. Sent on every request they would make
 * each write conditional on one stale value, or a download partial, and on
 * /mcp they do not reach the write at all — so they are refused, not dropped.
 */
const requestScopedHeaders: Record<string, string> = {
  "if-match": "pass if_match to the write tool instead",
  "idempotency-key": "Anytype keys each write itself; toggle_chat_reaction takes idempotency_key",
  "if-none-match": "it applies to one request only",
  "if-range": "it applies to one request only",
  "if-modified-since": "it applies to one request only",
  "if-unmodified-since": "it applies to one request only",
  range: "download_file always fetches the whole file",
};

/** RFC 9110 token: what a header name may be. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * OPENAPI_MCP_HEADERS, the configuration every existing install carries: a JSON
 * object such as {"Authorization":"Bearer <key>","Anytype-Version":"2025-11-08"}.
 * Every value is checked here, before any request, so a malformed one is
 * reported by its header's name and never by its value.
 */
export function parseHeaders(env: NodeJS.ProcessEnv, warnings: string[] = []): Record<string, string> {
  const raw = env.OPENAPI_MCP_HEADERS;
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // the parser's message quotes the input, which holds the key
    throw new ConfigError('OPENAPI_MCP_HEADERS is not valid JSON; expected {"Authorization":"Bearer <key>"}');
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('OPENAPI_MCP_HEADERS must be a JSON object, e.g. {"Authorization":"Bearer <key>"}');
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!TOKEN.test(name)) throw new ConfigError("OPENAPI_MCP_HEADERS has a header name that is not a valid HTTP name");
    const lower = name.toLowerCase();
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && typeof value !== "number") {
      throw new ConfigError(`OPENAPI_MCP_HEADERS: the value of ${name} must be a string`);
    }
    if (transportHeaders.has(lower)) {
      warnings.push(`OPENAPI_MCP_HEADERS: ignoring ${name}, which the MCP transport sets itself`);
      continue;
    }
    if (lower in requestScopedHeaders) {
      throw new ConfigError(
        `OPENAPI_MCP_HEADERS sets ${name}, which cannot apply to every call: ${requestScopedHeaders[lower]}`,
      );
    }
    const text = String(value);
    try {
      new Headers([[name, text]]);
    } catch {
      throw new ConfigError(
        `OPENAPI_MCP_HEADERS: the value of ${name} is not a valid HTTP header value ` +
          "(it holds a line break or another control character); copy it again",
      );
    }
    headers[name] = text;
  }
  return headers;
}

/** True when the headers carry an Authorization value, in any spelling. */
export function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}
