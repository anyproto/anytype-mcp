const { spawn } = require("child_process");
const fs = require("fs");
const yaml = require("js-yaml");

const smitheryConfig = yaml.load(fs.readFileSync("smithery.yaml", "utf8"));

const config = {
  openapiMcpHeaders: smitheryConfig.startCommand.exampleConfig.openapiMcpHeaders,
  baseUrl: smitheryConfig.startCommand.exampleConfig.baseUrl,
};
console.log("config", config);

// Parse the commandFunction from smithery.yaml
const commandFunction = eval(smitheryConfig.startCommand.commandFunction);
const { command, env } = commandFunction(config);

// Build dockerArgs with env vars
const dockerArgs = [
  "run",
  "--rm",
  "-i", // Interactive mode for stdin
  ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  command,
];
console.log("dockerArgs", dockerArgs);

// MCP protocol: tools/list request (official MCP standard)
const listToolsRequest = {
  jsonrpc: "2.0",
  method: "tools/list",
  params: {},
  id: 1,
};

// Use docker run instead of direct command
const cli = spawn("docker", dockerArgs, {
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
