import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type { JSONSchema7 as IJsonSchema } from "json-schema";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { getOperationExclusion, getParameterPolicy, isFileDownload } from "./tool-policy";

type NewToolMethod = {
  name: string;
  description: string;
  inputSchema: IJsonSchema & { type: "object" };
  outputSchema?: IJsonSchema;
};

type FunctionParameters = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export class OpenAPIToMCPConverter {
  private schemaCache: Record<string, IJsonSchema> = {};

  constructor(private openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {}

  /**
   * Resolve a $ref reference to its schema in the openApiSpec.
   * Returns the raw OpenAPI SchemaObject or null if not found.
   */
  private internalResolveRef(ref: string, resolvedRefs: Set<string>): OpenAPIV3.SchemaObject | null {
    if (!ref.startsWith("#/")) {
      return null;
    }
    if (resolvedRefs.has(ref)) {
      return null;
    }

    const parts = ref.replace(/^#\//, "").split("/");
    let current: any = this.openApiSpec;
    for (const part of parts) {
      current = current[part];
      if (!current) return null;
    }
    resolvedRefs.add(ref);
    return current as OpenAPIV3.SchemaObject;
  }

  /**
   * Convert an OpenAPI schema (or reference) into a JSON Schema object.
   * Uses caching and handles cycles by returning $ref nodes.
   */
  convertOpenApiSchemaToJsonSchema(
    schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
    resolvedRefs: Set<string>,
    resolveRefs: boolean = true,
  ): IJsonSchema {
    if ("$ref" in schema) {
      const ref = schema.$ref;
      // TODO: Add support for filters
      if (ref === "#/components/schemas/FilterExpression") {
        return {};
      }
      if (!resolveRefs) {
        if (ref.startsWith("#/components/schemas/")) {
          return {
            $ref: ref.replace(/^#\/components\/schemas\//, "#/$defs/"),
            ...("description" in schema ? { description: schema.description as string } : {}),
          };
        }
        console.error(`Attempting to resolve ref ${ref} not found in components collection.`);
        // deliberate fall through
      }
      // Create base schema with $ref and description if present
      const refSchema: IJsonSchema = { $ref: ref };
      if ("description" in schema && schema.description) {
        refSchema.description = schema.description as string;
      }

      // If already cached, return immediately with description
      if (this.schemaCache[ref]) {
        return this.schemaCache[ref];
      }

      const resolved = this.internalResolveRef(ref, resolvedRefs);
      if (!resolved) {
        // TODO: need extensive tests for this and we definitely need to handle the case of self references
        console.error(`Failed to resolve ref ${ref}`);
        return {
          $ref: ref.replace(/^#\/components\/schemas\//, "#/$defs/"),
          description: "description" in schema ? ((schema.description as string) ?? "") : "",
        };
      } else {
        const converted = this.convertOpenApiSchemaToJsonSchema(resolved, resolvedRefs, resolveRefs);
        this.schemaCache[ref] = converted;

        return converted;
      }
    }

    // Handle inline schema
    const result: IJsonSchema = {};

    if (schema.type) {
      result.type = schema.type as IJsonSchema["type"];
    }

    // Convert binary format to uri-reference and enhance description
    if (schema.format === "binary") {
      result.format = "uri-reference";
      const binaryDesc = "absolute paths to local files";
      result.description = schema.description ? `${schema.description} (${binaryDesc})` : binaryDesc;
    } else {
      if (schema.format) {
        result.format = schema.format;
      }
      if (schema.description) {
        result.description = schema.description;
      }
    }

    if (schema.enum) {
      result.enum = schema.enum;
    }

    if (schema.default !== undefined) {
      result.default = schema.default;
    }

    // Handle object properties
    if (schema.type === "object") {
      result.type = "object";
      if (schema.properties) {
        result.properties = {};
        for (const [name, propSchema] of Object.entries(schema.properties)) {
          result.properties[name] = this.convertOpenApiSchemaToJsonSchema(propSchema, resolvedRefs, resolveRefs);
        }
      }
      if (schema.required) {
        result.required = schema.required;
      }
      if (schema.additionalProperties === true || schema.additionalProperties === undefined) {
        result.additionalProperties = true;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        result.additionalProperties = this.convertOpenApiSchemaToJsonSchema(
          schema.additionalProperties,
          resolvedRefs,
          resolveRefs,
        );
      } else {
        result.additionalProperties = false;
      }
    }

    // Handle arrays - ensure binary format conversion happens for array items too
    if (schema.type === "array" && schema.items) {
      result.type = "array";
      result.items = this.convertOpenApiSchemaToJsonSchema(schema.items, resolvedRefs, resolveRefs);
    }

    if (schema.oneOf) {
      // Special handling for icon schema - only keep emoji definition
      const hasEmojiIcon = schema.oneOf.some(
        (def) => typeof def === "object" && "$ref" in def && def.$ref === "#/components/schemas/EmojiIcon",
      );

      if (hasEmojiIcon) {
        return {
          type: "object",
          description: schema.description,
          properties: {
            emoji: {
              type: "string",
              description: "The emoji of the icon",
            },
            format: {
              type: "string",
              description: "The format of the icon",
              enum: ["emoji"],
            },
          },
          additionalProperties: true,
        };
      }

      // Special handling for property value types
      const isPropertyValue = schema.oneOf.every(
        (def) => typeof def === "object" && "$ref" in def && def.$ref.endsWith("PropertyValue"),
      );
      const isPropertyLinkValue = schema.oneOf.every(
        (def) => typeof def === "object" && "$ref" in def && def.$ref.endsWith("PropertyLinkValue"),
      );

      if (isPropertyValue || isPropertyLinkValue) {
        const isLink = isPropertyLinkValue;
        const baseProperties = {
          ...(isLink
            ? {
                key: {
                  type: "string",
                  description: "The key of the property",
                  examples: ["last_modified_date"],
                },
              }
            : {
                id: {
                  type: "string",
                  description: "The id of the property",
                  examples: ["last_modified_date"],
                },
                key: {
                  type: "string",
                  description: "The key of the property",
                  examples: ["last_modified_date"],
                },
                name: {
                  type: "string",
                  description: "The name of the property",
                  examples: ["Last modified date"],
                },
                object: {
                  type: "string",
                  description: "The data model of the object",
                  examples: ["property"],
                },
              }),
        } as Record<string, IJsonSchema>;

        return {
          type: "object",
          properties: {
            ...baseProperties,
            text: {
              type: "string",
              description: "The text value, if applicable",
              examples: ["Some text..."],
            },
            number: {
              type: "number",
              description: "The number value, if applicable",
              examples: [42],
            },
            select: {
              type: "string",
              description: "The selected tag id, if applicable",
              examples: ["tag_id"],
            },
            multi_select: {
              type: "array",
              description: "The selected tag ids, if applicable",
              items: {
                type: "string",
              },
              examples: [["tag_id"]],
            },
            date: {
              type: "string",
              description: "The date value in ISO 8601 format, if applicable",
              examples: ["2025-02-14T12:34:56Z"],
            },
            files: {
              type: "array",
              description: "The file ids, if applicable",
              items: {
                type: "string",
              },
              examples: [["['file_id']"]],
            },
            checkbox: {
              type: "boolean",
              description: "The checkbox value, if applicable",
              examples: [true],
            },
            url: {
              type: "string",
              description: "The url value, if applicable",
              examples: ["https://example.com"],
            },
            email: {
              type: "string",
              description: "The email value, if applicable",
              examples: ["example@example.com"],
            },
            phone: {
              type: "string",
              description: "The phone number value, if applicable",
              examples: ["+1234567890"],
            },
            objects: {
              type: "array",
              description: "The object ids, if applicable",
              items: {
                type: "string",
              },
              examples: [["['object_id']"]],
            },
          } as Record<string, IJsonSchema>,
        };
      }
    }

    // oneOf, anyOf, allOf
    if (schema.oneOf) {
      result.oneOf = schema.oneOf.map((s) => this.convertOpenApiSchemaToJsonSchema(s, resolvedRefs, resolveRefs));
    }
    if (schema.anyOf) {
      result.anyOf = schema.anyOf.map((s) => this.convertOpenApiSchemaToJsonSchema(s, resolvedRefs, resolveRefs));
    }
    if (schema.allOf) {
      result.allOf = schema.allOf.map((s) => this.convertOpenApiSchemaToJsonSchema(s, resolvedRefs, resolveRefs));
    }

    return result;
  }

  convertToMCPTools(): {
    tools: Record<string, { methods: NewToolMethod[] }>;
    openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>;
    zip: Record<string, { openApi: OpenAPIV3.OperationObject & { method: string; path: string }; mcp: NewToolMethod }>;
  } {
    const apiName = "API";

    const openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }> = {};
    const tools: Record<string, { methods: NewToolMethod[] }> = {
      [apiName]: { methods: [] },
    };
    const zip: Record<
      string,
      { openApi: OpenAPIV3.OperationObject & { method: string; path: string }; mcp: NewToolMethod }
    > = {};
    for (const operation of this.getOperations()) {
      const mcpMethod = this.convertOperationToMCPMethod(operation, operation.method, operation.path);
      if (!mcpMethod) continue;
      // Normalize and truncate the final advertised name, including its prefix.
      const fullName = `${apiName}-${mcpMethod.name.replaceAll("_", "-")}`.slice(0, 64);
      const previous = openApiLookup[fullName];
      if (previous) {
        throw new Error(
          `Duplicate tool name "${fullName}": ${previous.method} ${previous.path} and ${operation.method} ${operation.path}. Use distinct operationIds or separate API specs.`,
        );
      }
      mcpMethod.name = fullName.slice(apiName.length + 1);
      tools[apiName].methods.push(mcpMethod);
      openApiLookup[fullName] = operation;
      zip[fullName] = { openApi: operation, mcp: mcpMethod };
    }

    return { tools, openApiLookup, zip };
  }

  /** All formats use the same input schemas, parameter policy, and capability checks. */
  convertToOpenAITools(): ChatCompletionTool[] {
    return Object.values(this.convertToMCPTools().zip).map(({ openApi, mcp }) => ({
      type: "function",
      function: {
        name: openApi.operationId!,
        description: mcp.description,
        parameters: mcp.inputSchema as FunctionParameters,
      },
    }));
  }

  convertToAnthropicTools(): Tool[] {
    return Object.values(this.convertToMCPTools().zip).map(({ openApi, mcp }) => ({
      name: openApi.operationId!,
      description: mcp.description,
      input_schema: mcp.inputSchema as Tool["input_schema"],
    }));
  }

  private *getOperations(): Generator<OpenAPIV3.OperationObject & { method: string; path: string }> {
    for (const [path, pathItem] of Object.entries(this.openApiSpec.paths || {})) {
      if (!pathItem) continue;
      for (const [method, rawOperation] of Object.entries(pathItem)) {
        if (!this.isOperation(method, rawOperation)) continue;
        // Operation-level parameters override inherited parameters of the same name/location.
        const parameters = new Map<string, OpenAPIV3.ParameterObject>();
        for (const raw of [...(pathItem.parameters || []), ...(rawOperation.parameters || [])]) {
          const parameter = this.resolveParameter(raw);
          if (!parameter) throw new Error(`Unresolved parameter at ${method} ${path}`);
          parameters.set(`${parameter.in}:${parameter.name}`, parameter);
        }
        const operation = {
          ...rawOperation,
          ...(parameters.size ? { parameters: [...parameters.values()] } : {}),
          method,
          path,
        };
        const responses = Object.entries(operation.responses || {})
          .filter(([status]) => /^2(?:[0-9]{2}|XX)$/i.test(status))
          .map(([, response]) => this.resolveResponse(response))
          .filter((response): response is OpenAPIV3.ResponseObject => response !== null);
        if (!getOperationExclusion(operation, path, responses)) yield operation;
      }
    }
  }

  private isOperation(method: string, operation: any): operation is OpenAPIV3.OperationObject {
    return ["get", "post", "put", "delete", "patch"].includes(method.toLowerCase());
  }

  private isParameterObject(
    param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject,
  ): param is OpenAPIV3.ParameterObject {
    return !("$ref" in param);
  }

  private isRequestBodyObject(
    body: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject,
  ): body is OpenAPIV3.RequestBodyObject {
    return !("$ref" in body);
  }

  resolveParameter(param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject): OpenAPIV3.ParameterObject | null {
    if (this.isParameterObject(param)) {
      return param;
    } else {
      const resolved = this.internalResolveRef(param.$ref, new Set());
      if (resolved && (resolved as OpenAPIV3.ParameterObject).name) {
        return resolved as OpenAPIV3.ParameterObject;
      }
    }
    return null;
  }

  private resolveRequestBody(
    body: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject,
  ): OpenAPIV3.RequestBodyObject | null {
    if (this.isRequestBodyObject(body)) {
      return body;
    } else {
      const resolved = this.internalResolveRef(body.$ref, new Set());
      if (resolved) {
        return resolved as OpenAPIV3.RequestBodyObject;
      }
    }
    return null;
  }

  /** The converted JSON body schema used to decide whether MCP inputs are flat or wrapped in `body`. */
  getJsonRequestBodySchema(operation: OpenAPIV3.OperationObject): IJsonSchema | undefined {
    if (!operation.requestBody) return undefined;
    const body = this.resolveRequestBody(operation.requestBody);
    // MCP tools prefer multipart when both media types are offered.
    if (body?.content["multipart/form-data"]?.schema) return undefined;
    const schema = body?.content["application/json"]?.schema;
    return schema ? this.convertOpenApiSchemaToJsonSchema(schema, new Set(), true) : undefined;
  }

  private resolveResponse(
    response: OpenAPIV3.ResponseObject | OpenAPIV3.ReferenceObject,
  ): OpenAPIV3.ResponseObject | null {
    if ("$ref" in response) {
      const resolved = this.internalResolveRef(response.$ref, new Set());
      if (resolved) {
        return resolved as OpenAPIV3.ResponseObject;
      } else {
        return null;
      }
    }
    return response;
  }

  private convertOperationToMCPMethod(
    operation: OpenAPIV3.OperationObject,
    method: string,
    path: string,
  ): NewToolMethod | null {
    if (!operation.operationId) {
      console.warn(`Operation without operationId at ${method} ${path}`);
      return null;
    }

    const methodName = operation.operationId;

    const inputSchema: IJsonSchema & { type: "object" } = {
      type: "object",
      properties: {},
      required: [],
    };

    // Handle parameters (path, query, header, cookie)
    if (operation.parameters) {
      for (const param of operation.parameters) {
        const paramObj = this.resolveParameter(param);
        if (paramObj) {
          const policy = getParameterPolicy(paramObj);
          if (policy.mode === "configured" || policy.mode === "omitted") continue;
          if (!paramObj.schema) {
            if (paramObj.required) throw new Error(`Required parameter ${paramObj.name} has no supported schema`);
            continue;
          }
          const schema = { ...this.convertOpenApiSchemaToJsonSchema(paramObj.schema, new Set(), true) };
          if (policy.description || paramObj.description) {
            schema.description = policy.description || paramObj.description;
          }
          if (Object.hasOwn(inputSchema.properties!, policy.inputName)) {
            throw new Error(`Conflicting tool input "${policy.inputName}" for ${methodName}`);
          }
          inputSchema.properties![policy.inputName] = schema;
          if (paramObj.required && policy.mode !== "idempotency") {
            inputSchema.required!.push(policy.inputName);
          }
        }
      }
    }

    // Handle requestBody
    if (operation.requestBody) {
      const bodyObj = this.resolveRequestBody(operation.requestBody);
      if (bodyObj?.content) {
        // Handle multipart/form-data for file uploads
        // We convert the multipart/form-data schema to a JSON schema and we require
        // that the user passes in a string for each file that points to the local file
        if (bodyObj.content["multipart/form-data"]?.schema) {
          const formSchema = this.convertOpenApiSchemaToJsonSchema(
            bodyObj.content["multipart/form-data"].schema,
            new Set(),
            true,
          );
          if (formSchema.type === "object" && formSchema.properties) {
            for (const [name, propSchema] of Object.entries(formSchema.properties)) {
              // TODO: Add support for filters
              if (name === "filters") continue;
              if (Object.hasOwn(inputSchema.properties!, name)) {
                throw new Error(`Body field "${name}" conflicts with a tool parameter for ${methodName}`);
              }
              inputSchema.properties![name] = propSchema;
            }
            if (formSchema.required) {
              inputSchema.required!.push(...formSchema.required!.filter((r) => r !== "filters"));
            }
          }
        }
        // Handle application/json
        else if (bodyObj.content["application/json"]?.schema) {
          const bodySchema = this.getJsonRequestBodySchema(operation)!;
          // Merge body schema into the inputSchema's properties
          if (bodySchema.type === "object" && bodySchema.properties) {
            for (const [name, propSchema] of Object.entries(bodySchema.properties)) {
              // TODO: Add support for filters
              if (name === "filters") continue;
              if (Object.hasOwn(inputSchema.properties!, name)) {
                throw new Error(`Body field "${name}" conflicts with a tool parameter for ${methodName}`);
              }
              inputSchema.properties![name] = propSchema;
            }
            if (bodySchema.required) {
              inputSchema.required!.push(...bodySchema.required!.filter((r) => r !== "filters"));
            }
          } else {
            // Open-ended objects and non-object documents are passed intact under "body".
            inputSchema.properties!["body"] = bodySchema;
            inputSchema.required!.push("body");
          }
        }
      }
    }

    let description = operation.summary || operation.description || "";
    if (isFileDownload({ ...operation, method })) {
      description += ". Saves locally and returns path, filename, media_type, and size in bytes.";
    }
    const outputSchema: IJsonSchema | null = isFileDownload({ ...operation, method })
      ? {
          type: "object",
          properties: {
            path: { type: "string" },
            filename: { type: "string" },
            media_type: { type: "string" },
            size: { type: "integer" },
          },
          required: ["path", "filename", "media_type", "size"],
        }
      : this.extractResponseType(operation.responses);
    return {
      name: methodName,
      description,
      inputSchema: this.completeSchema(inputSchema) as IJsonSchema & { type: "object" },
      ...(outputSchema ? { outputSchema: this.completeSchema(outputSchema) } : {}),
    };
  }

  /** Include only definitions used by unresolved/recursive references. */
  private completeSchema(schema: IJsonSchema): IJsonSchema {
    const definitions: Record<string, IJsonSchema> = {};
    const pending = new Set<string>();
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("$ref" in value && typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
        pending.add(value.$ref.slice("#/$defs/".length));
      }
      Object.values(value).forEach(collect);
    };
    collect(schema);
    for (const name of pending) {
      const raw = this.openApiSpec.components?.schemas?.[name];
      if (!raw) throw new Error(`Unresolved schema definition: ${name}`);
      const definition = this.convertOpenApiSchemaToJsonSchema(
        raw as OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
        new Set(),
        false,
      );
      definitions[name] = definition;
      collect(definition);
    }
    return { ...schema, ...(pending.size ? { $defs: definitions } : {}) };
  }

  private extractResponseType(responses: OpenAPIV3.ResponsesObject | undefined): IJsonSchema | null {
    // Look for a success response
    const successResponse = responses?.["200"] || responses?.["201"] || responses?.["202"] || responses?.["204"];
    if (!successResponse) return null;

    const responseObj = this.resolveResponse(successResponse);
    if (!responseObj || !responseObj.content) return null;

    if (responseObj.content["application/json"]?.schema) {
      const outputSchema = this.convertOpenApiSchemaToJsonSchema(
        responseObj.content["application/json"].schema,
        new Set(),
        true,
      );

      // Preserve the response description if available and not already set
      if (responseObj.description && !outputSchema.description) {
        outputSchema.description = responseObj.description;
      }

      return outputSchema;
    }

    // If no JSON response, fallback to a generic string or known formats
    if (responseObj.content["image/png"] || responseObj.content["image/jpeg"]) {
      return { type: "string", format: "binary", description: responseObj.description || "" };
    }

    // Fallback
    return { type: "string", description: responseObj.description || "" };
  }
}
