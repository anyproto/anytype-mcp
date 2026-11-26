import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { legacyFallback } from "../legacy-fallback";
import { startStdioProxy } from "../stdio-proxy";
import { FAKE_KEY, FakeHeart } from "./fake-heart";

const v2Spec = JSON.parse(
  readFileSync(new URL("../../legacy/openapi/__tests__/fixtures/anytype-v2.json", import.meta.url), "utf8"),
);

let heart: FakeHeart | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await heart?.stop();
});

it("serves an Anytype without /mcp through the generated tools, over the same stdio", async () => {
  heart = await new FakeHeart({ withoutMcp: true, openapi: v2Spec }).start();
  // the generated-tools server reads its address and key from the environment, as it always did
  vi.stubEnv("ANYTYPE_API_BASE_URL", heart.url);
  vi.stubEnv("OPENAPI_MCP_HEADERS", JSON.stringify({ Authorization: `Bearer ${FAKE_KEY}` }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const input = new PassThrough();
  const output = new PassThrough();
  const received = new Map<unknown, Record<string, any>>();
  const arrived = new Map<unknown, () => void>();
  createInterface({ input: output }).on("line", (line) => {
    const message = JSON.parse(line);
    received.set(message.id, message);
    arrived.get(message.id)?.();
  });
  const answer = (id: number) =>
    received.has(id)
      ? Promise.resolve(received.get(id)!)
      : new Promise<Record<string, any>>((resolve) => arrived.set(id, () => resolve(received.get(id)!)));
  const proxy = startStdioProxy({
    baseUrl: heart.url,
    tier: "full",
    headers: { Authorization: `Bearer ${FAKE_KEY}` },
    input,
    output,
    legacyFallback,
    log: () => {},
  });

  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n",
  );
  const initialized = await answer(1);
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  const listed = await answer(2);
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "API-list-spaces", arguments: {} },
    }) + "\n",
  );
  const called = await answer(3);
  input.end();
  await proxy.closed;

  expect(initialized.result.serverInfo.name).toBe("Anytype API");
  expect(listed.result.tools.map((t: any) => t.name)).toContain("API-list-spaces");
  // the generated tool reached Anytype's REST route with the configured key
  const spacesCall = heart.requests.find((r) => r.path.startsWith("/v2/spaces"));
  expect(spacesCall?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  expect(called.result).toBeDefined();
  // only initialize went to /mcp; everything after it stayed with the fallback
  expect(heart.requests.filter((r) => r.path.startsWith("/mcp/")).length).toBe(1);
});
