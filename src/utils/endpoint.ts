import { URL } from "node:url";
import { OpenAPIV3 } from "openapi-types";

/**
 * Parses the ANYTYPE_API_ENDPOINT environment variable and returns the origin.
 * Returns null if not set, invalid, or uses an unsupported protocol.
 */
export function parseEndpointFromEnv(): string | null {
  const endpoint = process.env.ANYTYPE_API_ENDPOINT;
  if (!endpoint) {
    return null;
  }

  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(
        `ANYTYPE_API_ENDPOINT must use http:// or https:// protocol, got: ${url.protocol}. Ignoring and using fallback.`,
      );
      return null;
    }
    return url.origin;
  } catch (error) {
    console.warn("Failed to parse ANYTYPE_API_ENDPOINT environment variable:", error);
    return null;
  }
}

/**
 * Determines the base URL using priority order:
 * 1. ANYTYPE_API_ENDPOINT environment variable
 * 2. OpenAPI spec servers[0].url
 * 3. Default fallback: http://127.0.0.1:31009
 */
export function determineBaseUrl(openApiSpec?: OpenAPIV3.Document): string {
  // Priority 1: Environment variable
  const envEndpoint = parseEndpointFromEnv();
  if (envEndpoint) {
    console.error(`Using base URL from ANYTYPE_API_ENDPOINT: ${envEndpoint}`);
    return envEndpoint;
  }

  // Priority 2: OpenAPI spec servers[0].url
  const specUrl = openApiSpec?.servers?.[0]?.url;
  if (specUrl) {
    console.error(`Using base URL from OpenAPI spec: ${specUrl}`);
    return specUrl;
  }

  // Priority 3: Default fallback
  const defaultUrl = "http://127.0.0.1:31009";
  console.error(`Using default base URL: ${defaultUrl}`);
  return defaultUrl;
}

/**
 * Gets the default OpenAPI spec URL.
 * If ANYTYPE_API_ENDPOINT is set, uses it with /docs/openapi.json suffix.
 * Otherwise, returns the default spec URL.
 */
export function getDefaultSpecUrl(): string {
  const endpoint = parseEndpointFromEnv();
  if (endpoint) {
    return `${endpoint}/docs/openapi.json`;
  }
  return "http://127.0.0.1:31009/docs/openapi.json";
}
