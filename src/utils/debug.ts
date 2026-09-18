/** Debug output intentionally excludes arguments, headers, URLs, and response bodies. */
export function debug(event: string, details: { operationId?: string; status?: number; durationMs?: number } = {}) {
  if (process.env.ANYTYPE_MCP_DEBUG === "1") {
    console.error(`[anytype-mcp] ${event}`, details);
  }
}
