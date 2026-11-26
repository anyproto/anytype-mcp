// The proxy as a real MCP client sees it: the SDK's Client negotiates,
// validates every result against the MCP schema, and calls tools through the
// proxy's stdio framing to a fake Anytype. Stdout is read with the SDK's own
// stdio reader (ReadBuffer, what its StdioClientTransport uses), so its frame
// limit applies here as it does in a host.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { startStdioProxy, type RunningProxy } from "../stdio-proxy";
import { FAKE_KEY, FakeHeart, type CallHandler } from "./fake-heart";

/** StdioClientTransport's framing over in-memory streams instead of a child process. */
class StreamTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly reader: ReadBuffer;

  constructor(
    private readonly toProxy: PassThrough,
    private readonly fromProxy: PassThrough,
    maxBufferSize?: number,
  ) {
    this.reader = new ReadBuffer(maxBufferSize ? { maxBufferSize } : undefined);
  }

  async start() {
    this.fromProxy.on("data", (chunk: Buffer) => {
      try {
        this.reader.append(chunk);
        for (let message = this.reader.readMessage(); message; message = this.reader.readMessage()) {
          this.onmessage?.(message);
        }
      } catch (error) {
        // what StdioClientTransport does on a frame past its limit: report it and close
        this.onerror?.(error as Error);
        void this.close();
      }
    });
  }

  async send(message: JSONRPCMessage) {
    this.toProxy.write(serializeMessage(message));
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

async function connect(call: CallHandler, maxBufferSize?: number) {
  heart = await new FakeHeart({ call }).start();
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
  await client.connect(new StreamTransport(toProxy, fromProxy, maxBufferSize));
  return client;
}

it("serves the MCP SDK client: negotiation, tools/list and tools/call pass its schema checks", async () => {
  const client = await connect(async () => ({
    content: [{ type: "text", text: '{"data":[]}' }],
    structuredContent: { data: [] },
  }));

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
  expect(heart!.posted.map((m) => m.method)).toContain("notifications/initialized");
});

// The full tier returns a result twice (text and structuredContent), so a
// 6 MiB result is a frame over the SDK reader's default 10 MiB: a host needs
// a larger maxBufferSize for such reads (docs/tool-behavior.md).
const sixMiB = "x".repeat(6 * 1024 * 1024);
const large: CallHandler = async () => ({
  content: [{ type: "text", text: sixMiB }],
  structuredContent: { body: sixMiB },
});

it("delivers a 6 MiB result to an SDK reader with a larger maxBufferSize", async () => {
  const client = await connect(large, 64 * 1024 * 1024);

  const result = await client.callTool({ name: "list_spaces", arguments: {} });
  await client.close();

  expect((result.content as Array<{ text: string }>)[0].text.length).toBe(sixMiB.length);
}, 20_000);

it("overruns the SDK reader's default 10 MiB with a 6 MiB result, as hosts with the default will", async () => {
  const client = await connect(large);

  await expect(client.callTool({ name: "list_spaces", arguments: {} })).rejects.toThrow();
}, 20_000);
