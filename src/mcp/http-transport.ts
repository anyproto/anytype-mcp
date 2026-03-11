import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { MCPProxy } from "./proxy";

export const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

const MCP_HTTP_PATH = "/mcp";

export function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

export async function startHttpTransport(
  proxy: MCPProxy,
  host: string,
  port: number,
  passthroughHeaders: string[],
): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const { method, url } = req;
    console.error(`[http] ${method} ${url}`);

    applyCorsHeaders(req, res);

    if (url !== MCP_HTTP_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    switch (method) {
      case "OPTIONS":
        res.writeHead(204);
        res.end();
        break;

      case "GET":
      case "POST": {
        // Forward only whitelisted headers from MCP client to upstream Anytype API
        const requestHeaders: Record<string, string> = {};
        for (const name of passthroughHeaders) {
          const value = req.headers[name];
          if (typeof value === "string") requestHeaders[name] = value;
        }

        // Stateless mode: fresh transport per request
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await proxy.clone(requestHeaders).connect(transport);
        res.on("close", () => transport.close().catch(() => {}));
        await transport.handleRequest(req, res);
        break;
      }

      default:
        res.writeHead(405, { Allow: CORS_HEADERS["Access-Control-Allow-Methods"], "Content-Type": "text/plain" });
        res.end("Method Not Allowed: MCP endpoint accepts POST only");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.error(`HTTP transport on http://${host}:${port}${MCP_HTTP_PATH}`);
}
