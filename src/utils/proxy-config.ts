import { z } from "zod";

const TransportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio") }),
  z.object({
    type: z.literal("http"),
    port: z.coerce.number().int().min(1024).max(65535).default(3666),
  }),
]);

const McpProxyConfigSchema = z.object({
  transport: TransportSchema.default({ type: "stdio" }),
  openApiHeaders: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return {} as Record<string, string>;
      try {
        return z.record(z.string(), z.string()).parse(JSON.parse(val));
      } catch {
        console.warn("Failed to parse OPENAPI_MCP_HEADERS, ignoring");
        return {} as Record<string, string>;
      }
    }),
});

export type McpProxyConfig = z.infer<typeof McpProxyConfigSchema>;

export const mcpProxyConfig: McpProxyConfig = McpProxyConfigSchema.parse({
  transport: process.env.MCP_TRANSPORT === "http" ? { type: "http", port: process.env.MCP_PORT } : { type: "stdio" },
  openApiHeaders: process.env.OPENAPI_MCP_HEADERS,
});
