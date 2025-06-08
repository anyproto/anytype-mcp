import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAPIV3 } from "openapi-types";
import { MCPProxy } from "./mcp/proxy";

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

export async function loadOpenApiSpec(specPath?: string): Promise<OpenAPIV3.Document> {
  const filename = fileURLToPath(import.meta.url);
  const directory = path.dirname(filename);
  const defaultFilePath = path.resolve(directory, "../scripts/openapi.json");
  const defaultUrl =
    specPath && (specPath.startsWith("http://") || specPath.startsWith("https://"))
      ? specPath
      : "http://localhost:31009/docs/openapi.json";

  const fallbackFilePath =
    specPath && !specPath.match(/^https?:\/\//) ? path.resolve(process.cwd(), specPath) : defaultFilePath;
  let rawSpec: string;

  try {
    const response = await axios.get(defaultUrl);
    rawSpec = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    console.error(`Loaded OpenAPI spec from URL: ${defaultUrl}`);
  } catch (err: any) {
    // console.warn(`Could not load spec from ${defaultUrl}: ${err.code}. Falling back to file system: ${fallbackFilePath}`);
    try {
      rawSpec = fs.readFileSync(fallbackFilePath, "utf-8");
    } catch (fsErr: any) {
      console.error(`Failed to read OpenAPI spec file at ${fallbackFilePath}: ${fsErr.message}`);
      process.exit(1);
    }
  }

  try {
    return JSON.parse(rawSpec) as OpenAPIV3.Document;
  } catch (parseErr: any) {
    console.error("Failed to parse OpenAPI specification:", parseErr.message);
    process.exit(1);
  }
}

export async function initProxy(specPath: string) {
  const openApiSpec = await loadOpenApiSpec(specPath);
  const proxy = new MCPProxy("Anytype API", openApiSpec);

  // console.error("Connecting to Anytype API...");
  return proxy.connect(new StdioServerTransport());
}
