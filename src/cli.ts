import { ApiKeyGenerator } from "./auth/get-key";
import { initProxy, loadOpenApiSpec } from "./legacy/init-server";
import { hasAuthorization, parseHeadersFromEnv, resolveBaseUrl, resolveTier } from "./proxy/config";
import { legacyFallback } from "./proxy/legacy-fallback";
import { startStdioProxy } from "./proxy/stdio-proxy";
import { determineBaseUrl } from "./utils/base-url";

export const usage = `Usage:
  anytype-mcp [run] [--tier small|large|full]   proxy stdio to Anytype's built-in MCP server (default tier: full)
  anytype-mcp run <openapi-spec-url-or-file>    serve tools generated from that OpenAPI document (legacy)
  anytype-mcp get-key [<openapi-spec>]          pair with Anytype and print an API key

Environment:
  OPENAPI_MCP_HEADERS    JSON headers, e.g. {"Authorization":"Bearer <key>"}
  ANYTYPE_API_BASE_URL   Anytype's API address (default http://127.0.0.1:31009)
  ANYTYPE_MCP_TIER       small, large or full, when --tier is not given`;

/** Splits `--tier <name>` / `--tier=<name>` from the positional arguments. */
export function parseArgs(args: string[]): { positional: string[]; tier?: string } {
  const positional: string[] = [];
  let tier: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tier") {
      if (i + 1 >= args.length) throw new Error("--tier needs a value: small, large or full");
      tier = args[++i];
    } else if (arg.startsWith("--tier=")) {
      tier = arg.slice("--tier=".length);
    } else {
      positional.push(arg);
    }
  }
  return { positional, tier };
}

async function generateApiKey(specPath?: string) {
  // a spec named explicitly says where the server is; otherwise ANYTYPE_API_BASE_URL or the default
  const baseUrl = specPath ? determineBaseUrl(await loadOpenApiSpec(specPath)) : resolveBaseUrl();
  await new ApiKeyGenerator(baseUrl).generateApiKey();
}

function runProxy(tierFlag: string | undefined) {
  const tier = resolveTier(tierFlag);
  const baseUrl = resolveBaseUrl();
  const headers = parseHeadersFromEnv();
  if (!hasAuthorization(headers)) {
    console.error(
      'OPENAPI_MCP_HEADERS has no "Authorization": "Bearer <key>" entry; Anytype will refuse every call. ' +
        "Create a key in Anytype → Settings → API keys, or run `anytype-mcp get-key`.",
    );
  }
  const proxy = startStdioProxy({ baseUrl, tier, headers, legacyFallback });
  console.error(`Anytype MCP: forwarding stdio to ${new URL(`/mcp/${tier}`, baseUrl).href}`);
  const stop = () => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // stdin closing (the host going away) ends the session; the process then exits on its own
  return proxy;
}

export async function main(args: string[] = process.argv.slice(2)) {
  const { positional, tier } = parseArgs(args);
  const [command, specPath] = positional;
  if (!command || command === "run") {
    if (specPath) {
      if (tier !== undefined)
        console.error("--tier selects a table of Anytype's built-in MCP server; it is ignored with a spec");
      await initProxy(specPath);
    } else {
      runProxy(tier);
    }
  } else if (command === "get-key") {
    await generateApiKey(specPath);
  } else if (command === "help" || command === "--help" || command === "-h") {
    console.error(usage);
  } else {
    console.error(`Error: Unknown command "${command}"\n\n${usage}`);
    process.exit(1);
  }
}
