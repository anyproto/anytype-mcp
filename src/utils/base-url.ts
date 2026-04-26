import { OpenAPIV3 } from "openapi-types";
import { getConfig } from "./config";

export const DEFAULT_BASE_URL = "http://127.0.0.1:31009";
const DEFAULT_SPEC_PATH = "/docs/openapi.json";

/**
 * Determines the base URL using priority order:
 * 1. ANYTYPE_API_BASE_URL environment variable
 * 2. OpenAPI spec servers[0].url
 * 3. Default fallback: http://127.0.0.1:31009
 */
export function determineBaseUrl(openApiSpec?: OpenAPIV3.Document): string {
  // Priority 1: Environment variable
  const { baseUrl } = getConfig().httpClient;
  if (baseUrl) {
    console.error(`Using base URL from ANYTYPE_API_BASE_URL: ${baseUrl}`);
    return baseUrl;
  }

  // Priority 2: OpenAPI spec servers[0].url
  const specUrl = openApiSpec?.servers?.[0]?.url;
  if (specUrl) {
    console.error(`Using base URL from OpenAPI spec: ${specUrl}`);
    return specUrl;
  }

  // Priority 3: Default fallback
  console.error(`Using default base URL: ${DEFAULT_BASE_URL}`);
  return DEFAULT_BASE_URL;
}

let specPathOverride: string | undefined;

/**
 * Sets the spec path explicitly (from CLI params).
 */
export function overrideSpecPath(specPath?: string) {
  specPathOverride = specPath;
}

/**
 * Returns the spec path resolved in the following order:
 * 1. From overridden, if any ({@link overrideSpecPath}),
 * 2. From config, if any
 * 3. Default one.
 */
export function resolveSpecPath() {
  return specPathOverride ?? `${getConfig().httpClient.baseUrl ?? DEFAULT_BASE_URL}${DEFAULT_SPEC_PATH}`;
}
