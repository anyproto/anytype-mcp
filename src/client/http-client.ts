import type { AxiosInstance } from "axios";
import FormData from "form-data";
import fs from "fs";
import { Headers } from "node-fetch";
import { randomUUID } from "node:crypto";
import OpenAPIClientAxios from "openapi-client-axios";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { isFileUploadParameter } from "../openapi/file-upload";
import { OpenAPIToMCPConverter } from "../openapi/parser";
import { getParameterPolicy, isFileDownload } from "../openapi/tool-policy";
import { debug } from "../utils/debug";
import { readDownloadError, saveDownload } from "./download-file";

export type HttpClientConfig = {
  baseUrl: string;
  headers?: Record<string, string>;
};

export type HttpClientResponse<T = any> = {
  data: T;
  status: number;
  headers: Headers;
  requestKey?: string;
};

export class HttpClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any,
    public headers?: Headers,
    public requestKey?: string,
  ) {
    super(`${status} ${message}`);
    this.name = "HttpClientError";
  }
}

export class HttpClient {
  private api: Promise<AxiosInstance>;
  private client: OpenAPIClientAxios;
  private converter: OpenAPIToMCPConverter;
  private configuredHeaders: Record<string, string>;

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    this.converter = new OpenAPIToMCPConverter(openApiSpec);
    this.configuredHeaders = Object.fromEntries(
      Object.entries(config.headers || {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    if (this.configuredHeaders["idempotency-key"] !== undefined) {
      throw new Error("A global Idempotency-Key would be reused across writes. Use request_key on individual calls.");
    }
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
    const fileParams = isFileUploadParameter(operation);
    if (fileParams.length === 0) return null;

    const formData = new FormData();

    // Handle file uploads
    for (const param of fileParams) {
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
            for (const file of filePath) {
              addFile(param, file);
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
   * Execute an OpenAPI operation
   */
  async executeOperation<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any> = {},
    options: { signal?: globalThis.AbortSignal } = {},
  ): Promise<HttpClientResponse<T>> {
    const api = await this.api;
    const operationId = operation.operationId;
    if (!operationId) {
      throw new Error("Operation ID is required");
    }

    // OpenAPIClientAxios routes declared parameters to path, query, headers,
    // and cookies. Remove them before constructing either JSON or multipart bodies.
    const requestParameters: Record<string, any> = {};
    const bodyArguments = { ...params };
    let requestKey: string | undefined;
    for (const parameter of operation.parameters || []) {
      const param = this.converter.resolveParameter(parameter);
      if (param) {
        const policy = getParameterPolicy(param);
        if (policy.mode === "configured" || policy.mode === "omitted") {
          delete bodyArguments[param.name];
          if (policy.mode === "configured" && param.required && !this.configuredHeaders[param.name.toLowerCase()]) {
            throw new Error(`Required header ${param.name} must be set in OPENAPI_MCP_HEADERS`);
          }
          continue;
        }
        const names = [
          ...new Set([policy.inputName, policy.legacyName, param.name].filter((name) => name !== undefined)),
        ];
        const supplied = names.filter((name) => Object.hasOwn(params, name) && params[name] !== undefined);
        const value = supplied.length ? params[supplied[0]] : undefined;
        if (supplied.some((name) => params[name] !== value)) {
          throw new Error(`Conflicting values for ${policy.inputName} and its legacy header alias`);
        }
        names.forEach((name) => delete bodyArguments[name]);
        if (policy.mode === "idempotency") {
          if (value !== undefined && (typeof value !== "string" || !value.trim())) {
            throw new Error("request_key must be a non-empty string");
          }
          // Generated once per invocation; any transport replay of this prepared
          // request keeps the header. Separate invocations get separate keys.
          requestKey = value ?? randomUUID();
          requestParameters[param.name] = requestKey;
        } else if (value !== undefined) {
          requestParameters[param.name] = value;
        }
      }
    }

    const formData = await this.prepareFileUpload(operation, bodyArguments);
    const bodySchema = this.converter.getJsonRequestBodySchema(operation);
    // Use the same converted schema as the tool generator: a real document
    // property named "body" must remain wrapped when its object schema is flat.
    const wrappedBody = bodySchema && !(bodySchema.type === "object" && bodySchema.properties);
    let bodyParams: any;
    if (!operation.requestBody) {
      Object.assign(requestParameters, bodyArguments);
    } else if (formData) {
      bodyParams = formData;
    } else if (wrappedBody) {
      bodyParams = bodyArguments.body;
    } else if (Object.keys(bodyArguments).length > 0) {
      bodyParams = bodyArguments;
    }

    const operationFn = (api as any)[operationId];
    if (!operationFn) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const startedAt = Date.now();
    debug("request", { operationId });
    try {
      // If we have form data, we need to set the correct headers
      const hasBody = bodyParams !== undefined;
      const headers = formData
        ? formData.getHeaders()
        : { ...(hasBody ? { "Content-Type": "application/json" } : { "Content-Type": null }) };
      const requestConfig = {
        headers: {
          ...headers,
        },
        ...(isFileDownload(operation) ? { responseType: "stream" as const } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };

      // First argument is OpenAPI parameters; second is the actual request document.
      const response = await operationFn(requestParameters, bodyParams, requestConfig);
      debug("response", { operationId, status: response.status, durationMs: Date.now() - startedAt });
      // Convert axios headers to Headers object
      const responseHeaders = new Headers();
      Object.entries(response.headers).forEach(([key, value]) => {
        if (value) responseHeaders.append(key, value.toString());
      });

      let data = response.data;
      if (isFileDownload(operation)) {
        try {
          data = await saveDownload(response.data, responseHeaders, options.signal);
        } catch {
          throw new HttpClientError("Download failed", 0, {
            code: "download_failed",
            message: "Could not save the downloaded file.",
          });
        }
      }

      return {
        data,
        status: response.status,
        headers: responseHeaders,
        ...(requestKey ? { requestKey } : {}),
      };
    } catch (error: any) {
      if (error instanceof HttpClientError) throw error;
      if (error.response) {
        debug("http_error", { operationId, status: error.response.status, durationMs: Date.now() - startedAt });
        const headers = new Headers();
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString());
        });

        throw new HttpClientError(
          error.response.statusText || "Request failed",
          error.response.status,
          isFileDownload(operation) ? await readDownloadError(error.response.data) : error.response.data,
          headers,
          requestKey,
        );
      }
      debug("transport_error", { operationId, durationMs: Date.now() - startedAt });
      throw new HttpClientError(
        "No response received",
        0,
        {
          code: "transport_error",
          message: "No response received; the operation may have completed.",
          ...(requestKey ? { hint: "Retry the same write with the returned request_key." } : {}),
        },
        undefined,
        requestKey,
      );
    }
  }
}
