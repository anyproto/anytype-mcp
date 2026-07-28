import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { Headers } from "node-fetch";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { OpenAPIV3 } from "openapi-types";
import { HttpClient, HttpClientError } from "../client/http-client";
import { OpenAPIToMCPConverter } from "../openapi/parser";
import { determineBaseUrl } from "../utils/base-url";

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject;
  put?: OpenAPIV3.OperationObject;
  post?: OpenAPIV3.OperationObject;
  delete?: OpenAPIV3.OperationObject;
  patch?: OpenAPIV3.OperationObject;
};

type NewToolDefinition = {
  methods: Array<{
    name: string;
    description: string;
    inputSchema: IJsonSchema & { type: "object" };
    outputSchema?: IJsonSchema;
  }>;
};

export class MCPProxy {
  private server: Server;
  private httpClient: HttpClient;
  private tools: Record<string, NewToolDefinition>;
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>;

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
    const baseUrl = determineBaseUrl(openApiSpec);
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: this.parseHeadersFromEnv(),
      },
      openApiSpec,
    );

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec);
    const { tools, openApiLookup } = converter.convertToMCPTools();
    this.tools = tools;
    this.openApiLookup = openApiLookup;

    this.setupHandlers();
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [];

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach((method) => {
          const toolNameWithMethod = `${toolName}-${method.name}`;
          const truncatedToolName = this.truncateToolName(toolNameWithMethod);
          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool["inputSchema"],
          });
        });
      });

      return { tools };
    });

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error("calling tool", request.params);
      const { name, arguments: params } = request.params;

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name);
      console.error("operations", this.openApiLookup);
      if (!operation) {
        throw new Error(`Method ${name} not found`);
      }

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, params);

        // Convert response to MCP format
        return { content: [this.formatResponse(response.data, response.headers, operation, params)] };
      } catch (error) {
        console.error("Error in tool call", error);
        if (error instanceof HttpClientError) {
          console.error("HttpClientError encountered, returning structured error", error);
          const data = error.data?.response?.data ?? error.data ?? {};
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "error", // TODO: get this from http status code?
                  ...(typeof data === "object" ? data : { data: data }),
                }),
              },
            ],
          };
        }
        throw error;
      }
    });
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null;
  }

  private parseHeadersFromEnv(): Record<string, string> {
    const headersJson = process.env.OPENAPI_MCP_HEADERS;
    if (!headersJson) {
      return {};
    }

    try {
      const headers = JSON.parse(headersJson);
      if (typeof headers !== "object" || headers === null) {
        console.warn("OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:", typeof headers);
        return {};
      }
      return headers;
    } catch (error) {
      console.warn("Failed to parse OPENAPI_MCP_HEADERS environment variable:", error);
      return {};
    }
  }

  private getContentType(headers: Headers): "text" | "image" | "binary" {
    const contentType = headers.get("content-type");
    if (!contentType) return "binary";

    if (contentType.includes("text") || contentType.includes("json")) {
      return "text";
    } else if (contentType.includes("image")) {
      return "image";
    }
    return "binary";
  }

  private formatResponse(
    data: unknown,
    headers: Headers,
    operation: OpenAPIV3.OperationObject,
    params: Record<string, unknown> | undefined,
  ) {
    const contentType = this.getContentType(headers);
    const mimeType = headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
    const binaryData = this.toBuffer(data);

    // Preserve the existing JSON/text response behavior. Some APIs omit a
    // Content-Type header, so only treat actual byte containers as binary.
    if (contentType === "text" || !binaryData) {
      return {
        type: "text" as const,
        text: JSON.stringify(data),
      };
    }

    const base64Data = binaryData.toString("base64");
    if (contentType === "image") {
      return {
        type: "image" as const,
        data: base64Data,
        mimeType,
      };
    }

    return {
      type: "resource" as const,
      resource: {
        uri: this.buildResourceUri(operation, params),
        blob: base64Data,
        mimeType,
      },
    };
  }

  private toBuffer(data: unknown): Buffer | null {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  private buildResourceUri(operation: OpenAPIV3.OperationObject, params: Record<string, unknown> | undefined): string {
    const operationId = encodeURIComponent(operation.operationId || "response");
    const resourceUri = new URL(`anytype://api/${operationId}`);

    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && typeof value !== "object") {
        resourceUri.searchParams.set(key, String(value));
      }
    }

    return resourceUri.toString();
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport);
  }
}
