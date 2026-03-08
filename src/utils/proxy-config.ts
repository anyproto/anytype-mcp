import { URL } from "node:url";
import { z } from "zod";

export const BASE_ENV_KEYS = [
  "MCP_TRANSPORT",
  "MCP_HOST",
  "MCP_PORT",
  "ANYTYPE_API_BASE_URL",
  "OPENAPI_MCP_HEADERS",
] as const;
export type ProxyConfigEnv = Partial<Record<(typeof BASE_ENV_KEYS)[number], string | undefined>>;

const TransportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio") }),
  z.object({
    type: z.literal("http"),
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(1024).max(65535).default(3666),
  }),
]);

const McpProxyConfigSchema = z.object({
  transport: TransportSchema.default({ type: "stdio" }),

  /**
   * Parses the ANYTYPE_API_BASE_URL environment variable and returns the origin.
   * Returns null if not set, invalid, or uses an unsupported protocol.
   */
  anytypeApiBaseUrl: z
    .url({ protocol: /^https?$/ })
    .transform((v) => new URL(v).origin)
    .optional(),
  openApiHeaders: z
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

export type McpProxyConfig = z.infer<typeof McpProxyConfigSchema>;

export const mcpProxyConfig: McpProxyConfig = McpProxyConfigSchema.parse({
  transport:
    process.env.MCP_TRANSPORT === "http"
      ? { type: "http", host: process.env.MCP_HOST, port: process.env.MCP_PORT }
      : { type: "stdio" },
  anytypeApiBaseUrl: process.env.ANYTYPE_API_BASE_URL,
  openApiHeaders: process.env.OPENAPI_MCP_HEADERS,
});
