import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import axios from "axios";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { OpenAPIV3 } from "openapi-types";
import { MCPProxy } from "./mcp/proxy";
import { getDefaultSpecUrl } from "./utils/base-url";
import { mcpProxyConfig } from "./utils/proxy-config";

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

export async function loadOpenApiSpec(specPath?: string): Promise<OpenAPIV3.Document> {
  const finalSpec = specPath || getDefaultSpecUrl();
  let rawSpec: string;

  if (finalSpec.startsWith("http://") || finalSpec.startsWith("https://")) {
    try {
      const response = await axios.get(finalSpec);
      rawSpec = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    } catch (error: any) {
      if (error.code === "ECONNREFUSED") {
        console.error("Can't connect to API. Please ensure Anytype is running and reachable.");
        process.exit(1);
      }
      console.error("Failed to fetch OpenAPI specification from URL:", error.message);
      process.exit(1);
    }
  } else {
    const filePath = path.resolve(process.cwd(), finalSpec);
    try {
      rawSpec = fs.readFileSync(filePath, "utf-8");
    } catch (error: any) {
      console.error("Failed to read OpenAPI specification file:", error.message || String(error));
      process.exit(1);
    }
  }

  try {
    return JSON.parse(rawSpec) as OpenAPIV3.Document;
  } catch (error: any) {
    console.error("Failed to parse OpenAPI specification:", error.message);
    process.exit(1);
  }
}

async function startHttpTransport(port: number) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  const server = http.createServer((req, res) => {
    if (req.url === "/mcp") transport.handleRequest(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.error(`HTTP transport on http://localhost:${port}/mcp`);
  return transport;
}

export async function initProxy(specPath: string) {
  console.error("Initializing Anytype MCP Server...");
  const openApiSpec = await loadOpenApiSpec(specPath);
  const proxy = new MCPProxy("Anytype API", openApiSpec);
  const { transport: transportConfig } = mcpProxyConfig;
  const transport =
    transportConfig.type === "http" ? await startHttpTransport(transportConfig.port) : new StdioServerTransport();

  await proxy.connect(transport);
  console.error(`Anytype MCP Server running on ${transportConfig.type}`);
}
