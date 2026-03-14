import { URL } from "node:url";
import { z } from "zod";

export const ENV_KEYS = [
  "MCP_TRANSPORT",
  "MCP_HOST",
  "MCP_PORT",
  "MCP_PASSTHROUGH_HEADERS",
  "ANYTYPE_API_BASE_URL",
  "OPENAPI_MCP_HEADERS",
] as const;

export type ConfigEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

/**
 * Headers allowed to be forwarded from MCP HTTP requests to the upstream API.
 * Prevents header injection attacks (Host, Content-Length, Transfer-Encoding, etc.).
 */
export const DEFAULT_PASSTHROUGH_HEADERS = ["authorization", "anytype-version"] as const;

const TransportConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio") }),
  z.object({
    type: z.literal("http"),
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(1024).max(65535).default(3666),
    /**
     * Comma-separated list of inbound MCP HTTP transport header names (lowercase) to forward
     * to the upstream API. Defaults to DEFAULT_PASSTHROUGH_HEADERS.
     */
    passthroughHeaders: z
      .string()
      .optional()
      .transform((val) =>
        val
          ? val
              .split(",")
              .map((h) => h.trim().toLowerCase())
              .filter(Boolean)
          : [...DEFAULT_PASSTHROUGH_HEADERS],
      ),
  }),
]);

export type TransportConfig = z.infer<typeof TransportConfigSchema>;

const HttpClientConfigSchema = z.object({
  /**
   * Parses ANYTYPE_API_BASE_URL and returns the origin.
   * Falls back to OpenAPI spec servers[0].url, then http://127.0.0.1:31009.
   */
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .transform((v) => new URL(v).origin)
    .optional(),

  /**
   * JSON object of headers forwarded to the upstream API on every request.
   * Parsed from OPENAPI_MCP_HEADERS.
   */
  headers: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return {} as Record<string, string>;
      try {
        return z.record(z.string(), z.string()).parse(JSON.parse(val));
      } catch {
        console.error("Failed to parse OPENAPI_MCP_HEADERS, ignoring");
        return {} as Record<string, string>;
      }
    }),
});

export type HttpClientConfig = z.infer<typeof HttpClientConfigSchema>;

/**
 * Anytype MCP server config schema.
 */
const ConfigSchema = z.object({
  /**
   * MCP Server transport.
   * Currently can be either of: stdio (default) and http.
   */
  transport: TransportConfigSchema.default({ type: "stdio" }),

  /**
   * Target/upstream Anytype OpenAPI client config.
   */
  httpClient: HttpClientConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

let config: Config | undefined;

export function getConfig() {
  if (!config) {
    config = ConfigSchema.parse({
      transport:
        process.env.MCP_TRANSPORT === "http"
          ? {
              type: "http",
              host: process.env.MCP_HOST,
              port: process.env.MCP_PORT,
              passthroughHeaders: process.env.MCP_PASSTHROUGH_HEADERS,
            }
          : { type: "stdio" },
      httpClient: {
        baseUrl: process.env.ANYTYPE_API_BASE_URL,
        headers: process.env.OPENAPI_MCP_HEADERS,
      },
    });
  }

  return config;
}
