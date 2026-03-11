import axios, { type AxiosInstance } from "axios";
import FormData from "form-data";
import fs from "fs";
import { Headers } from "node-fetch";
import OpenAPIClientAxios from "openapi-client-axios";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { isFileUploadParameter } from "../openapi/file-upload";
import { DEFAULT_BASE_URL } from "../utils/base-url";
import type { HttpClientConfig } from "../utils/config";

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
  private baseHeaders: Record<string, string>;

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    this.baseHeaders = config.headers ?? {};
    const baseURL = config.baseUrl ?? (openApiSpec as OpenAPIV3.Document)?.servers?.[0]?.url ?? DEFAULT_BASE_URL;
    // @ts-expect-error OpenAPIClientAxios can be imported as default or named export, we handle both cases
    this.client = new (OpenAPIClientAxios.default ?? OpenAPIClientAxios)({
      definition: openApiSpec,
      axiosConfigDefaults: {
        baseURL,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "anytype-mcp-server",
          ...this.baseHeaders,
        },
      },
    });
    this.api = this.client.init();
  }

  /**
   * Returns a new HttpClient that merges the given headers into every request.
   * Per-request headers (e.g. Authorization passthrough) take precedence over base headers.
   */
  withHeaders(headers: Record<string, string>): HttpClient {
    const clone = Object.create(HttpClient.prototype) as HttpClient;
    clone.baseHeaders = { ...this.baseHeaders, ...headers };
    clone.client = this.client;
    clone.api = this.api;
    return clone;
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
          throw new Error(`Failed to read file at ${filePath}: ${error}`);
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
          ...this.baseHeaders,
          ...headers,
        },
      };

      // first argument is url parameters, second is body parameters
      const response = await operationFn(urlParameters, hasBody ? bodyParams : undefined, requestConfig);
      // Convert axios headers to Headers object
      const responseHeaders = new Headers();
      Object.entries(response.headers).forEach(([key, value]) => {
        if (value) responseHeaders.append(key, value.toString());
      });

      return {
        data: response.data,
        status: response.status,
        headers: responseHeaders,
      };
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response) {
        const headers = new Headers();
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString());
        });
        console.error("HTTP error", {
          operationId,
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          requestUrl: error.config?.url,
          requestMethod: error.config?.method,
          requestData: error.config?.data,
        });
        throw new HttpClientError(
          error.response.statusText || "Request failed",
          error.response.status,
          error.response.data,
          headers,
        );
      }
      throw error;
    }
  }
}
