import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAPIV3 } from "openapi-types";
import { AppKeyGenerator } from "../src/auth/get-key";
import { MCPProxy } from "../src/mcp/proxy";

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

function isYamlFile(filePath: string): boolean {
  return filePath.endsWith(".yaml") || filePath.endsWith(".yml");
}

export async function loadOpenApiSpec(specPath?: string): Promise<OpenAPIV3.Document> {
  let rawSpec: string;
  const defaultSpecPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "openapi.json");
  const finalSpecPath = specPath || defaultSpecPath;

  // Check if the path is a URL
  if (finalSpecPath.startsWith("http://") || finalSpecPath.startsWith("https://")) {
    try {
      const response = await axios.get(finalSpecPath);
      if (typeof response.data === "string") {
        rawSpec = response.data;
      } else {
        rawSpec = JSON.stringify(response.data);
      }
    } catch (error: any) {
      if (error.code === "ECONNREFUSED") {
        console.error("Can't connect to API. Please ensure Anytype is running and reachable.");
        process.exit(1);
      }
      console.error("Failed to fetch OpenAPI specification from URL:", error.message);
      process.exit(1);
    }
  } else {
    // Load from local file system
    try {
      rawSpec = fs.readFileSync(path.resolve(process.cwd(), finalSpecPath), "utf-8");
    } catch (error) {
      console.error("Failed to read OpenAPI specification file:", (error as Error).message);
      process.exit(1);
    }
  }

  // Parse and validate the spec
  try {
    const parsed = isYamlFile(finalSpecPath) ? yaml.load(rawSpec) : JSON.parse(rawSpec);
    return parsed as OpenAPIV3.Document;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    console.error("Failed to parse OpenAPI specification:", (error as Error).message);
    process.exit(1);
  }
}

async function runProxy(specPath?: string) {
  const openApiSpec = await loadOpenApiSpec(specPath);
  const proxy = new MCPProxy("Anytype API", openApiSpec);

  console.error("Connecting to Claude Desktop...");
  return proxy.connect(new StdioServerTransport());
}

async function getAppKey(specPath?: string) {
  const openApiSpec = await loadOpenApiSpec(specPath);
  const basePath = openApiSpec.servers?.[0]?.url || "http://localhost:31009";
  const generator = new AppKeyGenerator(basePath);
  await generator.generateAppKey();
}

// Main execution
export async function main(args: string[] = process.argv.slice(2)) {
  const command = args[0];

  if (!command || command === "run") {
    const specPath = command === "run" ? args[1] : undefined;
    await runProxy(specPath);
    return;
  }

  if (command === "get-key") {
    const getKeySpecPath = args[1];
    await getAppKey(getKeySpecPath);
    return;
  }

  console.error(`Error: Unknown command "${command}"`);
  console.error('Run "anytype-mcp" without arguments to see available commands');
  process.exit(1);
}

const shouldStart = process.argv[1].endsWith("anytype-mcp");
// Only run main if this is the entry point
if (shouldStart) {
  main().catch((error) => {
    if (error instanceof ValidationError) {
      console.error("Invalid OpenAPI 3.1 specification:");
      error.errors.forEach((err) => console.error(err));
    } else {
      console.error("Error:", error.message);
    }
    process.exit(1);
  });
}
