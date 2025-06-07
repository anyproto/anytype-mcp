import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { OpenAPIV3 } from "openapi-types";
import { MCPProxy } from "./mcp/proxy";

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

export async function loadOpenApiSpec(specPath?: string): Promise<OpenAPIV3.Document> {
  const defaultSpecUrl = process.env.ANYTYPE_API_BUNDLED_SPEC_PATH || "http://localhost:31009/docs/openapi.json";
  const finalSpec = specPath || defaultSpecUrl;
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
    rawSpec = fs.readFileSync(filePath, "utf-8");
  }

  try {
    return JSON.parse(rawSpec) as OpenAPIV3.Document;
  } catch (error: any) {
    console.error("Failed to parse OpenAPI specification:", error.message);
    process.exit(1);
  }
}

export async function initProxy(specPath: string) {
  const openApiSpec = await loadOpenApiSpec(specPath);
  const proxy = new MCPProxy("Anytype API", openApiSpec);

  console.error("Connecting to Anytype API...");
  return proxy.connect(new StdioServerTransport());
}
