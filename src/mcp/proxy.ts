import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { Headers } from "node-fetch";
import { OpenAPIV3 } from "openapi-types";
import { HttpClient, HttpClientError } from "../client/http-client";
import { OpenAPIToMCPConverter } from "../openapi/parser";
import { getConfig } from "../utils/config";

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
  private state = {
    toolsLogged: false,
    serverInfo: { name: "", version: "" },
  };

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.state.serverInfo = { name, version: openApiSpec.info.version };
    this.server = new Server(this.state.serverInfo, { capabilities: { tools: {} } });
    this.httpClient = new HttpClient(getConfig().httpClient, openApiSpec);

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec);
    const { tools, openApiLookup } = converter.convertToMCPTools();
    this.tools = tools;
    this.openApiLookup = openApiLookup;

    this.setupHandlers();
  }

  setupHandlers() {
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
      const { name, arguments: params } = request.params;

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name);

      if (!this.state.toolsLogged) {
        const toolNames = Object.keys(this.openApiLookup);
        console.error(`tools (count: ${toolNames.length}): ${toolNames.join(", ")}`);
        this.state.toolsLogged = true;
      }

      if (!operation) {
        throw new Error(`Method ${name} not found`);
      }

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, params);

        // Convert response to MCP format
        return {
          content: [
            {
              type: "text", // currently this is the only type that seems to be used by mcp server
              text: JSON.stringify(response.data), // TODO: pass through the http status code text?
            },
          ],
        };
      } catch (error) {
        if (error instanceof HttpClientError) {
          const data = error.data?.response?.data ?? error.data ?? {};
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  typeof data === "object" ? { httpStatus: error.status, ...data } : { httpStatus: error.status, data },
                ),
              },
            ],
          };
        }

        console.error(`Unexpected error in "${name}" tool call`, error);

        // don’t leak internals or secrets, throw opaque error
        throw new Error("Internal server error while handling MCP request");
      }
    });
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null;
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

  /**
   * Creates a lightweight clone that reuses pre-parsed tools and HTTP client
   * but has a fresh Server instance, required for stateless HTTP transport
   * where each request needs its own Server/transport pair.
   * Optionally merges per-request headers (e.g. Authorization passthrough).
   */
  clone(requestHeaders?: Record<string, string>): MCPProxy {
    const instance = Object.create(MCPProxy.prototype) as MCPProxy;
    instance.state = this.state; // shared reference — mutations visible across clones
    instance.server = new Server(this.state.serverInfo, { capabilities: { tools: {} } });
    instance.httpClient = requestHeaders ? this.httpClient.withHeaders(requestHeaders) : this.httpClient;
    instance.tools = this.tools;
    instance.openApiLookup = this.openApiLookup;
    instance.setupHandlers();
    return instance;
  }
}
