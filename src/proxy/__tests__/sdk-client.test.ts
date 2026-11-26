// The proxy as a real MCP client sees it: the SDK's Client negotiates,
// validates every result against the MCP schema, and calls tools through the
// proxy's stdio framing to a fake Anytype.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { startStdioProxy, type RunningProxy } from "../stdio-proxy";
import { FAKE_KEY, FakeHeart } from "./fake-heart";

/** The SDK's stdio client framing, over in-memory streams instead of a child process. */
class StreamTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(
    private readonly toProxy: PassThrough,
    private readonly fromProxy: PassThrough,
  ) {}

  async start() {
    createInterface({ input: this.fromProxy }).on("line", (line) => this.onmessage?.(JSON.parse(line)));
  }

  async send(message: JSONRPCMessage) {
    this.toProxy.write(JSON.stringify(message) + "\n");
  }

  async close() {
    this.toProxy.end();
    this.onclose?.();
  }
}

let heart: FakeHeart | undefined;
let proxy: RunningProxy | undefined;
let filesDir: string | undefined;
afterEach(async () => {
  await proxy?.closed;
  await heart?.stop();
  if (filesDir) await rm(filesDir, { recursive: true, force: true });
});

it("serves the MCP SDK client: negotiation, tools/list and tools/call pass its schema checks", async () => {
  heart = await new FakeHeart({
    call: async () => ({ content: [{ type: "text", text: '{"data":[]}' }], structuredContent: { data: [] } }),
  }).start();
  filesDir = await mkdtemp(join(tmpdir(), "anytype-mcp-sdk-test-"));
  const toProxy = new PassThrough();
  const fromProxy = new PassThrough();
  proxy = startStdioProxy({
    baseUrl: heart.url,
    tier: "full",
    headers: { Authorization: `Bearer ${FAKE_KEY}` },
    filesDir,
    input: toProxy,
    output: fromProxy,
    log: () => {},
  });
  const client = new Client({ name: "sdk-conformance", version: "0" });

  await client.connect(new StreamTransport(toProxy, fromProxy));
  const { tools } = await client.listTools();
  const result = await client.callTool({ name: "list_spaces", arguments: {} });
  const local = await client.callTool({ name: "download_file", arguments: { space_id: "s", file_id: "missing" } });
  await client.close();

  expect(client.getServerVersion()).toEqual({ name: "anytype", version: "1" });
  expect(client.getInstructions()).toBe("fake heart instructions");
  expect(tools.map((t) => t.name)).toEqual(["list_spaces", "upload_file", "download_file", "upload_local_file"]);
  expect(result).toMatchObject({ structuredContent: { data: [] } });
  expect(local.isError).toBe(true);
  // the client's initialized notification reached Anytype
  expect(heart.posted.map((m) => m.method)).toContain("notifications/initialized");
});
