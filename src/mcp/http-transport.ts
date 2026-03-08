import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { MCPProxy } from "./proxy";

export const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

export async function startHttpTransport(proxy: MCPProxy, host: string, port: number): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const { method, url } = req;
    console.error(`[http] ${method} ${url}`);

    applyCorsHeaders(req, res);

    if (url === "/mcp") {
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
      } else if (method === "GET" || method === "POST") {
        // Stateless mode: fresh transport + fresh Server per request
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await proxy.clone().connect(transport);
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(405, { Allow: CORS_HEADERS["Access-Control-Allow-Methods"], "Content-Type": "text/plain" });
        res.end("Method Not Allowed: MCP endpoint accepts POST only");
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.error(`HTTP transport on http://${host}:${port}/mcp`);
}
