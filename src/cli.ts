import { ApiKeyGenerator } from "./auth/get-key";
import { ConfigError, loadConfig, resolveBaseUrl } from "./proxy/config";
import { startStdioProxy } from "./proxy/stdio-proxy";

export const usage = `Usage:
  anytype-mcp [run] [--tier small|large|full]   proxy stdio to Anytype's built-in MCP server (default tier: full)
  anytype-mcp get-key                           pair with Anytype and print an API key

Environment:
  OPENAPI_MCP_HEADERS     JSON headers, e.g. {"Authorization":"Bearer <key>"}
  ANYTYPE_API_BASE_URL    Anytype's API address (default http://127.0.0.1:31009)
  ANYTYPE_MCP_TIER        small, large or full, when --tier is not given
  ANYTYPE_MCP_FILES_DIR   the only directory upload_local_file and download_file use (default ~/.anytype-mcp/files)`;

/**
 * Version 2 took an OpenAPI document to generate tools from; that path is gone.
 * The document also chose the server (its servers[0].url), so removing it
 * without setting ANYTYPE_API_BASE_URL would send the key to the default port.
 * The proxy does not guess the address from where the spec was served: that
 * may be a documentation host, and the key must not go there.
 */
export function specArgumentGone(env: NodeJS.ProcessEnv = process.env): string {
  const address = env.ANYTYPE_API_BASE_URL?.trim()
    ? "keep your ANYTYPE_API_BASE_URL"
    : "open the spec and set ANYTYPE_API_BASE_URL to the API origin in its servers[0].url " +
      "(typically http://127.0.0.1:31009)";
  return (
    "anytype-mcp 3 no longer generates tools from an OpenAPI document. To use the MCP server built into Anytype " +
    `(heart >= 0.51.6), ${address}, then remove the spec argument. ` +
    'For an older Anytype, keep your arguments and pin version 2: "-y", "@anyproto/anytype-mcp@2.0.3", "run", <spec>.'
  );
}

/** Splits `--tier <name>` / `--tier=<name>` from the positional arguments. */
export function parseArgs(args: string[]): { positional: string[]; tier?: string } {
  const positional: string[] = [];
  let tier: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tier") {
      if (i + 1 >= args.length) throw new ConfigError("--tier needs a value: small, large or full");
      tier = args[++i];
    } else if (arg.startsWith("--tier=")) {
      tier = arg.slice("--tier=".length);
    } else {
      positional.push(arg);
    }
  }
  return { positional, tier };
}

/**
 * Serves stdio. A configuration the proxy cannot run with is still served:
 * every request is answered with the reason, which the host shows the user,
 * where an exit would leave only a line in a log file.
 */
function runProxy(tierFlag: string | undefined, configError?: string) {
  let options: Parameters<typeof startStdioProxy>[0] = { configError };
  if (!configError) {
    try {
      const config = loadConfig(tierFlag);
      config.warnings.forEach((warning) => console.error(warning));
      options = config;
      console.error(`Anytype MCP: forwarding stdio to ${new URL(`/mcp/${config.tier}`, config.baseUrl).href}`);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      options = { configError: error.message };
    }
  }
  if (options.configError) console.error(`Anytype MCP: ${options.configError}`);
  const proxy = startStdioProxy(options);
  const stop = () => {
    // abort stops reading at once, cancels calls in flight, waits for each to
    // settle (a partial download removes itself) and ends the session; then
    // whatever is still queued for stdout gets a moment to drain
    void proxy
      .abort()
      .then(drainStdout)
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // stdin closing (the host going away) drains the calls received, ends the session, and the process exits
  return proxy;
}

function drainStdout(): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdout.writableLength) return resolve();
    const timer = setTimeout(resolve, 1_000);
    process.stdout.once("drain", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function main(args: string[] = process.argv.slice(2)) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    runProxy(undefined, (error as Error).message);
    return;
  }
  const [command, ...rest] = parsed.positional;
  if (!command || command === "run") {
    runProxy(parsed.tier, rest.length > 0 ? specArgumentGone() : undefined);
  } else if (command === "get-key") {
    if (rest.length > 0) {
      // version 2 took a spec here and paired with the server it named; pairing elsewhere would be a surprise
      console.error(
        "anytype-mcp get-key takes no spec any more: set ANYTYPE_API_BASE_URL to pair with an Anytype that is not on the default port.",
      );
      process.exit(1);
      return;
    }
    await new ApiKeyGenerator(resolveBaseUrl()).generateApiKey();
  } else if (command === "help" || command === "--help" || command === "-h") {
    console.error(usage);
  } else {
    console.error(`Error: Unknown command "${command}"\n\n${usage}`);
    process.exit(1);
  }
}
