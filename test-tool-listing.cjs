const { spawn } = require("child_process");
const fs = require("fs");
const yaml = require("js-yaml");
const path = require("path");

// Read smithery.yaml to get openapiSpecPath and commandFunction
const smitheryConfig = yaml.load(fs.readFileSync("smithery.yaml", "utf8"));
const openapiSpecPath =
  smitheryConfig?.startCommand?.configSchema?.properties?.openapiSpecPath?.default || "./scripts/openapi.json";

console.log("Using OpenAPI spec path:", openapiSpecPath);

// Build config for commandFunction
const config = {
  openapiMcpHeaders: process.env.OPENAPI_MCP_HEADERS || "{}",
  baseUrl: process.env.BASE_URL,
  openapiSpecPath,
};

// Recreate the commandFunction logic from smithery.yaml
const env = { OPENAPI_MCP_HEADERS: config.openapiMcpHeaders };
if (config.baseUrl) env.BASE_URL = config.baseUrl;
if (config.openapiSpecPath) env.ANYTYPE_API_SPEC_FILE_PATH = config.openapiSpecPath;
const command = "anytype-mcp";
const args = [];

// MCP protocol: tools/list request (official MCP standard)
const listToolsRequest = {
  jsonrpc: "2.0",
  method: "tools/list",
  params: {},
  id: 1,
};

// Use the command and env from smithery.yaml's commandFunction
const cli = spawn(command, args, {
  env: { ...process.env, ...env },
  stdio: ["pipe", "pipe", "pipe"],
});

let responseBuffer = "";

cli.stdout.on("data", (data) => {
  const str = data.toString();
  responseBuffer += str;
  console.log("[STDOUT]", str); // Print all stdout for debugging
  // Try to parse as JSON when a full object is received
  try {
    const lines = responseBuffer.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const res = JSON.parse(line);
        if (res.id === 1 && res.result && res.result.tools) {
          console.log("✅ Tool listing works via stdio!");
          console.log("Tool listing response:", res.result.tools);
          cli.kill();
          process.exit(0);
        }
      } catch (e) {
        // Not a JSON line, print for debugging
        console.log("[NON-JSON LINE]", line);
      }
    }
  } catch (e) {
    // Not a full JSON object yet, keep buffering
  }
});

cli.stderr.on("data", (data) => {
  console.error("[STDERR]", data.toString());
});

cli.stdin.write(JSON.stringify(listToolsRequest) + "\n");

// Timeout in case of no response
setTimeout(() => {
  console.error("❌ Tool listing test failed: No response from CLI");
  cli.kill();
  process.exit(1);
}, 5000);
