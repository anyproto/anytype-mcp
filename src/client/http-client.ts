import type { AxiosInstance } from "axios";
import FormData from "form-data";
import fs from "fs";
import { Headers } from "node-fetch";
import { Buffer } from "node:buffer";
import OpenAPIClientAxios from "openapi-client-axios";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { isFileUploadParameter } from "../openapi/file-upload";

export type HttpClientConfig = {
  baseUrl: string;
  headers?: Record<string, string>;
};

export type HttpClientResponse<T = any> = {
  data: T;
  status: number;
  headers: Headers;
};

export class HttpClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any,
    public headers?: Headers,
  ) {
    super(`${status} ${message}`);
    this.name = "HttpClientError";
  }
}

export class HttpClient {
  private api: Promise<AxiosInstance>;
  private client: OpenAPIClientAxios;
  private openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document;

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    this.openApiSpec = openApiSpec;
    // @ts-expect-error OpenAPIClientAxios can be imported as default or named export, we handle both cases
    this.client = new (OpenAPIClientAxios.default ?? OpenAPIClientAxios)({
      definition: openApiSpec,
      axiosConfigDefaults: {
        baseURL: config.baseUrl,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "anytype-mcp-server",
          ...config.headers,
        },
      },
    });
    this.api = this.client.init();
  }

  private async prepareFileUpload(
    operation: OpenAPIV3.OperationObject,
    params: Record<string, any>,
  ): Promise<FormData | null> {
    console.error("prepareFileUpload", { operation, params });
    const fileParams = isFileUploadParameter(operation);
    if (fileParams.length === 0) return null;

    const formData = new FormData();

    // Handle file uploads
    for (const param of fileParams) {
      console.error(`extracting ${param}`, { params });
      const filePath = params[param];
      if (!filePath) {
        throw new Error(`File path must be provided for parameter: ${param}`);
      }
      switch (typeof filePath) {
        case "string":
          addFile(param, filePath);
          break;
        case "object":
          if (Array.isArray(filePath)) {
            let fileCount = 0;
            for (const file of filePath) {
              addFile(param, file);
              fileCount++;
            }
            break;
          }
        //deliberate fallthrough
        default:
          throw new Error(`Unsupported file type: ${typeof filePath}`);
      }

      function addFile(name: string, filePath: string) {
        try {
          const fileStream = fs.createReadStream(filePath);
          formData.append(name, fileStream);
        } catch (error) {
          throw new Error(`Failed to read file at ${filePath}: ${error}`, { cause: error });
        }
      }
    }

    // Add non-file parameters to form data
    for (const [key, value] of Object.entries(params)) {
      if (!fileParams.includes(key)) {
        formData.append(key, value);
      }
    }

    return formData;
  }

  /**
   * Whether an operation declares a binary success response. Axios otherwise
   * decodes response bodies as text, which can corrupt downloaded file bytes.
   */
  private hasBinaryResponse(operation: OpenAPIV3.OperationObject): boolean {
    const successStatuses = ["200", "201", "202", "203", "204", "206"];

    return successStatuses.some((status) => {
      const response = operation.responses?.[status];
      if (!response) return false;
      const responseObject =
        "$ref" in response ? this.resolveLocalRef<OpenAPIV3.ResponseObject>(response.$ref) : response;
      if (!responseObject) return false;

      return Object.entries(responseObject.content ?? {}).some(([mediaType, media]) => {
        const schema = media.schema;
        const schemaObject =
          schema && "$ref" in schema ? this.resolveLocalRef<OpenAPIV3.SchemaObject>(schema.$ref) : schema;
        const hasBinarySchema = schemaObject && !("$ref" in schemaObject) && schemaObject.format === "binary";

        return mediaType === "application/octet-stream" || mediaType.startsWith("image/") || hasBinarySchema;
      });
    });
  }

  private resolveLocalRef<T>(ref: string): T | null {
    if (!ref.startsWith("#/")) return null;

    let current: unknown = this.openApiSpec;
    for (const rawPart of ref.slice(2).split("/")) {
      const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!current || typeof current !== "object" || !(part in current)) return null;
      current = (current as Record<string, unknown>)[part];
    }
    return current as T;
  }

  /**
   * Axios returns every response as bytes when responseType is arraybuffer,
   * including JSON and text errors from binary download operations.
   */
  private decodeTextData(data: unknown, headers: Headers): unknown {
    let bytes: Buffer | null = null;
    if (Buffer.isBuffer(data)) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = Buffer.from(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    if (!bytes) return data;

    const contentType = headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("json") && !contentType.startsWith("text/")) return data;

    const text = bytes.toString("utf8");
    if (contentType.includes("json")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  /**
   * Execute an OpenAPI operation
   */
  async executeOperation<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any> = {},
  ): Promise<HttpClientResponse<T>> {
    const api = await this.api;
    const operationId = operation.operationId;
    if (!operationId) {
      throw new Error("Operation ID is required");
    }

    // Handle file uploads if present
    const formData = await this.prepareFileUpload(operation, params);

    // Separate parameters based on their location
    const urlParameters: Record<string, any> = {};
    const bodyParams: Record<string, any> = formData || { ...params };

    // Extract path and query parameters based on operation definition
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if ("name" in param && param.name && param.in) {
          if (param.in === "path" || param.in === "query") {
            if (params[param.name] !== undefined) {
              urlParameters[param.name] = params[param.name];
              if (!formData) {
                delete bodyParams[param.name];
              }
            }
          }
        }
      }
    }

    // Add all parameters as url parameters if there is no requestBody defined
    if (!operation.requestBody && !formData) {
      for (const key in bodyParams) {
        if (bodyParams[key] !== undefined) {
          urlParameters[key] = bodyParams[key];
          delete bodyParams[key];
        }
      }
    }

    const operationFn = (api as any)[operationId];
    if (!operationFn) {
      throw new Error(`Operation ${operationId} not found`);
    }

    try {
      // If we have form data, we need to set the correct headers
      const hasBody = Object.keys(bodyParams).length > 0;
      const headers = formData
        ? formData.getHeaders()
        : { ...(hasBody ? { "Content-Type": "application/json" } : { "Content-Type": null }) };
      const requestConfig = {
        headers: {
          ...headers,
        },
        ...(this.hasBinaryResponse(operation) ? { responseType: "arraybuffer" as const } : {}),
      };

      // first argument is url parameters, second is body parameters
      console.error("calling operation", { operationId, urlParameters, bodyParams, requestConfig });
      const response = await operationFn(urlParameters, hasBody ? bodyParams : undefined, requestConfig);

      console.error("operation finished");
      // Convert axios headers to Headers object
      const responseHeaders = new Headers();
      Object.entries(response.headers).forEach(([key, value]) => {
        if (value) responseHeaders.append(key, value.toString());
      });

      return {
        data: this.decodeTextData(response.data, responseHeaders) as T,
        status: response.status,
        headers: responseHeaders,
      };
    } catch (error: any) {
      if (error.response) {
        console.error("Error in http client", error);
        const headers = new Headers();
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString());
        });
        const data = this.decodeTextData(error.response.data, headers);

        throw new HttpClientError(error.response.statusText || "Request failed", error.response.status, data, headers);
      }
      throw error;
    }
  }
}
