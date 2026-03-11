import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { OpenAPIV3 } from "openapi-types";
import { startHttpTransport } from "./mcp/http-transport";
import { MCPProxy } from "./mcp/proxy";
import { resolveSpecPath } from "./utils/base-url";
import { getConfig } from "./utils/config";

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

export async function loadOpenApiSpec(): Promise<OpenAPIV3.Document> {
  const finalSpec = resolveSpecPath();
  let rawSpec: string | undefined;

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

export async function initProxy() {
  console.error("Initializing Anytype MCP Server...");
  const openApiSpec = await loadOpenApiSpec();
  const proxy = new MCPProxy("Anytype API", openApiSpec);
  const { transport: transportConfig } = getConfig();
  if (transportConfig.type === "http") {
    const { host, port, passthroughHeaders } = transportConfig;
    await startHttpTransport(proxy, host, port, passthroughHeaders);
  } else {
    await proxy.connect(new StdioServerTransport());
  }
  console.error(`Anytype MCP Server running on ${transportConfig.type}`);
}
