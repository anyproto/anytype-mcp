import type { AxiosInstance } from "axios";
import FormData from "form-data";
import fs from "fs";
import { Headers } from "node-fetch";
import OpenAPIClientAxios from "openapi-client-axios";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { isFileUploadParameter } from "../openapi/file-upload";
import { OpenAPIToMCPConverter } from "../openapi/parser";

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
  private converter: OpenAPIToMCPConverter;

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    this.converter = new OpenAPIToMCPConverter(openApiSpec);
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

    // OpenAPIClientAxios routes declared parameters to path, query, headers,
    // and cookies. Remove them before constructing either JSON or multipart bodies.
    const requestParameters: Record<string, any> = {};
    const bodyArguments = { ...params };
    for (const parameter of operation.parameters || []) {
      const param = this.converter.resolveParameter(parameter);
      if (param) {
        if (params[param.name] !== undefined) {
          requestParameters[param.name] = params[param.name];
        }
        delete bodyArguments[param.name];
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
      };

      // First argument is OpenAPI parameters; second is the actual request document.
      console.error("calling operation", { operationId, requestParameters, bodyParams, requestConfig });
      const response = await operationFn(requestParameters, bodyParams, requestConfig);

      console.error("operation finished");
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
      if (error.response) {
        console.error("Error in http client", error);
        const headers = new Headers();
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString());
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
