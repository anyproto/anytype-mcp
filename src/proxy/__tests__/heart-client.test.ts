import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Tier } from "../config";
import { describeFailure, HeartClient, parseEventStream, type HeartReply } from "../heart-client";
import { FAKE_KEY, FakeHeart, type FakeHeartOptions } from "./fake-heart";

const auth = { Authorization: `Bearer ${FAKE_KEY}`, "Anytype-Version": "2025-11-08" };
const initialize = (id: number | string = 1, protocolVersion = "2025-06-18") => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

let heart: FakeHeart | undefined;
afterEach(async () => {
  await heart?.stop();
  heart = undefined;
});

async function start(tier: Tier = "full", options: FakeHeartOptions = {}, headers: Record<string, string> = auth) {
  heart = await new FakeHeart(options).start();
  return new HeartClient({ baseUrl: heart.url, tier, headers });
}

function messages(reply: HeartReply) {
  if (reply.kind !== "messages") throw new Error(`expected messages, got ${JSON.stringify(reply)}`);
  return reply.messages;
}

describe("HeartClient against the /mcp contract", () => {
  it("posts one JSON-RPC message to /mcp/{tier} with the configured headers", async () => {
    const client = await start("full");

    const [answer] = messages(await client.send(initialize()));

    expect(answer).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "anytype" } } });
    const [request] = heart!.requests;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/mcp/full");
    expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(request.headers["anytype-version"]).toBe("2025-11-08");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.accept).toBe("application/json, text/event-stream");
    // no revision is claimed before initialize has negotiated one
    expect(request.headers["mcp-protocol-version"]).toBeUndefined();
  });

  it("sends the revision Anytype answered initialize with on every later request", async () => {
    const client = await start("full");
    // a revision Anytype's HTTP server does not speak: it answers with its newest
    await client.send(initialize(1, "2025-03-26"));
    expect(client.negotiatedVersion).toBe("2025-11-25");

    const [answer] = messages(await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

    expect(answer.result).toMatchObject({ tools: expect.any(Array) });
    expect(heart!.requests[1].headers["mcp-protocol-version"]).toBe("2025-11-25");
  });

  it("treats a notification's 202 as accepted, with nothing to relay", async () => {
    const client = await start("full");
    await client.send(initialize());

    expect(await client.send({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({ kind: "accepted" });
  });

  it("keeps the full tier sessionless", async () => {
    const client = await start("full");
    await client.send(initialize());
    await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(client.session).toBeUndefined();
    expect(heart!.requests.every((r) => r.headers["mcp-session-id"] === undefined)).toBe(true);
  });

  it.each(["small", "large"] as const)("echoes the %s tier's session id after initialize", async (tier) => {
    const client = await start(tier);
    await client.send(initialize());
    expect(client.session).toBe("session-1");

    const [answer] = messages(await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

    expect(answer.result).toBeDefined();
    expect(heart!.requests[1].headers["mcp-session-id"]).toBe("session-1");
  });

  it("re-opens an expired curated session with the client's initialize and resends the message once", async () => {
    const client = await start("small");
    await client.send(initialize(1, "2025-06-18"));
    heart!.expireSessions();

    const [answer] = messages(await client.send({ jsonrpc: "2.0", id: 7, method: "tools/list" }));

    expect(answer).toMatchObject({ id: 7, result: { tools: expect.any(Array) } });
    expect(client.session).toBe("session-2");
    expect(heart!.posted.map((m) => m.method)).toEqual([
      "initialize",
      "tools/list", // refused: the session expired
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    // the re-initialize repeats the client's own parameters
    expect(heart!.posted[2].params).toEqual(initialize().params);
  });

  it("shares one re-initialize among calls that find the session expired together", async () => {
    const client = await start("large");
    await client.send(initialize());
    heart!.expireSessions();

    const replies = await Promise.all([2, 3, 4].map((id) => client.send({ jsonrpc: "2.0", id, method: "ping" })));

    expect(replies.map((r) => messages(r)[0].id)).toEqual([2, 3, 4]);
    expect(heart!.posted.filter((m) => m.method === "initialize")).toHaveLength(2);
  });

  it("ends a curated session with DELETE on close", async () => {
    const client = await start("small");
    await client.send(initialize());

    await client.close();

    const last = heart!.requests.at(-1)!;
    expect(last.method).toBe("DELETE");
    expect(last.headers["mcp-session-id"]).toBe("session-1");
    expect(heart!.sessions.size).toBe(0);
    expect(client.session).toBeUndefined();
  });

  it("ends the previous session when the client initializes again", async () => {
    const client = await start("small");
    await client.send(initialize(1));
    await client.send(initialize(2));

    expect(heart!.requests.map((r) => r.method)).toEqual(["POST", "DELETE", "POST"]);
    expect([...heart!.sessions.keys()]).toEqual(["session-2"]);
  });

  it("relays the JSON-RPC error Anytype answers under HTTP 400 for a batch", async () => {
    const client = await start("full");

    const [answer] = messages(await client.send([{ jsonrpc: "2.0", id: 1, method: "ping" }]));

    expect(answer).toMatchObject({ id: null, error: { code: -32600 } });
  });
});

describe("HeartClient failures", () => {
  it("reports a rejected key as HTTP 401 with Anytype's message", async () => {
    const client = await start("full", {}, { Authorization: "Bearer wrong" });

    const reply = await client.send(initialize());

    expect(reply).toEqual({
      kind: "failed",
      failure: { kind: "http", status: 401, message: "invalid authorization header", routeMissing: false },
    });
    expect(describeFailure((reply as any).failure, client)).toMatch(/rejected the API key.*OPENAPI_MCP_HEADERS/);
  });

  it("marks gin's plain-text 404 of an Anytype without /mcp as a missing route", async () => {
    const client = await start("full", { withoutMcp: true });

    const reply = await client.send(initialize());

    expect(reply).toMatchObject({ kind: "failed", failure: { kind: "http", status: 404, routeMissing: true } });
    expect(describeFailure((reply as any).failure, client)).toMatch(/does not serve MCP at \/mcp\/full.*update/);
  });

  it("does not take Anytype's own JSON 404 for a missing route", async () => {
    heart = await new FakeHeart().start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "huge" as Tier, headers: auth });

    const reply = await client.send(initialize());

    expect(reply).toMatchObject({ kind: "failed", failure: { status: 404, routeMissing: false } });
    expect((reply as any).failure.message).toMatch(/unknown MCP tier/);
  });

  it("reports a closed port as unreachable", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const client = new HeartClient({ baseUrl: `http://127.0.0.1:${port}`, tier: "full", headers: auth });

    const reply = await client.send(initialize());

    expect(reply).toEqual({ kind: "failed", failure: { kind: "unreachable", detail: "ECONNREFUSED" } });
    expect(describeFailure((reply as any).failure, client)).toMatch(/Cannot reach Anytype at .*start the Anytype app/);
  });

  it("gives up on a server that never answers", async () => {
    heart = await new FakeHeart({ call: () => new Promise(() => {}) }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "full", headers: auth, timeoutMs: 100 });
    await client.send(initialize());

    const reply = await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces" } });

    expect(reply).toEqual({ kind: "failed", failure: { kind: "timeout", ms: 100 } });
  });

  it("reports a caller's abort as cancelled, not as a failure", async () => {
    heart = await new FakeHeart({ call: () => new Promise(() => {}) }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "full", headers: auth });
    const controller = new AbortController();

    const pending = client.send(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces" } },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);

    expect(await pending).toEqual({ kind: "cancelled" });
  });
});

describe("parseEventStream", () => {
  it("reads every JSON-RPC message from data lines, in order", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      ": keep-alive\n\n" +
      'data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}\n\n';

    expect(parseEventStream(body)).toEqual([
      { jsonrpc: "2.0", method: "notifications/progress", params: {} },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });
});
