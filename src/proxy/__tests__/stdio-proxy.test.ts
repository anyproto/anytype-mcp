import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tier } from "../config";
import { chooseVersion, SESSION_EXPIRED, startStdioProxy, type RunningProxy, type StartOptions } from "../stdio-proxy";
import { DEFAULT_TOOLS, FAKE_KEY, FakeHeart, type FakeHeartOptions } from "./fake-heart";

const auth = { Authorization: `Bearer ${FAKE_KEY}` };

/** A host on the other end of stdio: writes lines, waits for answers. */
class Host {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly lines: string[] = [];
  readonly logs: string[] = [];
  proxy!: RunningProxy;
  private wake: Array<() => void> = [];

  constructor() {
    createInterface({ input: this.output }).on("line", (line) => {
      this.lines.push(line);
      this.wake.splice(0).forEach((wake) => wake());
    });
  }

  get received(): Array<Record<string, any>> {
    return this.lines.map((line) => JSON.parse(line));
  }

  send(message: unknown) {
    this.input.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
  }

  async waitFor(match: (m: Record<string, any>) => boolean, timeoutMs = 2000): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching message; received ${JSON.stringify(this.lines)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.wake.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  answer(id: number | string | null) {
    return this.waitFor((m) => m.id === id);
  }

  async request(id: number, method: string, params?: Record<string, unknown>) {
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return this.answer(id);
  }

  initialize(protocolVersion = "2025-06-18") {
    return this.request(1, "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "host", version: "0" },
    });
  }
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
let heart: FakeHeart | undefined;
let host: Host | undefined;
let filesDir: string | undefined;
afterEach(async () => {
  host?.input.end();
  await host?.proxy.closed;
  await heart?.stop();
  if (filesDir) await rm(filesDir, { recursive: true, force: true });
  heart = host = filesDir = undefined;
});

async function connect(options: { tier?: Tier; heart?: FakeHeartOptions } & Partial<StartOptions> = {}) {
  heart = await new FakeHeart(options.heart).start();
  filesDir = await mkdtemp(join(tmpdir(), "anytype-mcp-stdio-test-"));
  host = new Host();
  host.proxy = startStdioProxy({
    baseUrl: heart.url,
    tier: options.tier ?? "full",
    headers: options.headers ?? auth,
    filesDir,
    configError: options.configError,
    input: host.input,
    output: host.output,
    log: (line) => host!.logs.push(line),
  });
  return host;
}

describe("stdio proxy over /mcp/full", () => {
  it("passes initialize through, Anytype's instructions and server info included", async () => {
    const h = await connect();

    expect(await h.initialize("2025-06-18")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "anytype", version: "1" },
        instructions: "fake heart instructions",
      },
    });
  });

  it("answers a 2024-11-05 client with its own revision while speaking Anytype's on HTTP", async () => {
    const h = await connect();

    const answer = await h.initialize("2024-11-05");
    await h.request(2, "tools/list");

    expect(answer.result.protocolVersion).toBe("2024-11-05");
    expect(heart!.requests[1].headers["mcp-protocol-version"]).toBe("2025-11-25");
  });

  it("does not promise 2025-03-26, whose batches it cannot honour", async () => {
    const h = await connect();

    const answer = await h.initialize("2025-03-26");

    expect(answer.result.protocolVersion).toBe("2024-11-05");
  });

  it("lists Anytype's tools unchanged, with the two local file tools after them", async () => {
    const h = await connect();
    await h.initialize();

    const answer = await h.request(2, "tools/list");

    expect(answer.result.tools.map((t: any) => t.name)).toEqual([
      "list_spaces",
      "upload_file",
      "download_file",
      "upload_local_file",
    ]);
    expect(answer.result.tools.slice(0, 2)).toEqual(DEFAULT_TOOLS);
  });

  it("steps aside for a local tool Anytype serves itself", async () => {
    const download = { name: "download_file", description: "served by Anytype", inputSchema: { type: "object" } };
    const h = await connect({ heart: { tools: [...DEFAULT_TOOLS, download] } });
    await h.initialize();

    const listed = await h.request(2, "tools/list");
    await h.request(3, "tools/call", { name: "download_file", arguments: { space_id: "s", file_id: "f" } });

    expect(listed.result.tools.filter((t: any) => t.name === "download_file")).toEqual([download]);
    expect(heart!.posted.at(-1)).toMatchObject({ method: "tools/call", params: { name: "download_file" } });
  });

  it("serves no local tools on a curated tier", async () => {
    const h = await connect({ tier: "small" });
    await h.initialize();

    const answer = await h.request(2, "tools/list");

    expect(answer.result.tools.map((t: any) => t.name)).toEqual(["list_spaces", "upload_file"]);
  });

  it("relays a tool result byte for byte", async () => {
    const result = { content: [{ type: "text", text: "big" }], structuredContent: { size: 12345 } };
    const h = await connect({ heart: { call: async () => result } });
    await h.initialize();

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: { limit: 3 } } });
    await h.answer(2);

    // JSON.stringify of the fake's result: what Anytype sent is what the host reads
    expect(h.lines.at(-1)).toBe(`{"id":2,"jsonrpc":"2.0","result":${JSON.stringify(result)}}`);
    expect(heart!.posted.at(-1)).toMatchObject({ params: { arguments: { limit: 3 } } });
  });

  it("keeps a large integer id exact", async () => {
    const h = await connect();
    await h.initialize();

    h.send('{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}');
    h.send('{"jsonrpc":"2.0","id":9007199254740992,"method":"ping"}');
    await h.waitFor(() => h.lines.length === 3);

    expect(h.lines.slice(1).sort()).toEqual([
      '{"id":9007199254740992,"jsonrpc":"2.0","result":{}}',
      '{"id":9007199254740993,"jsonrpc":"2.0","result":{}}',
    ]);
  });

  it("relays Anytype's protocol errors, such as an unknown tool", async () => {
    const h = await connect();
    await h.initialize();

    const answer = await h.request(2, "tools/call", { name: "nope", arguments: {} });

    expect(answer.error).toMatchObject({ code: -32602, message: expect.stringContaining("unknown tool") });
  });

  it("forwards notifications and answers nothing for them", async () => {
    const h = await connect();
    await h.initialize();

    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await h.request(2, "ping");

    expect(heart!.posted.map((m) => m.method)).toEqual(["initialize", "notifications/initialized", "ping"]);
    expect(h.received.map((m) => m.id)).toEqual([1, 2]);
  });
});

describe("stdio proxy refuses what Anytype would refuse, before acting on it", () => {
  it.each([
    ['{"id":3,"method":"tools/call","params":{"name":"download_file","arguments":{"space_id":"s","file_id":"f"}}}', 3],
    ["{not json", null],
    ['[{"jsonrpc":"2.0","id":5,"method":"ping"}]', null],
    // Anytype's decoder would take ID as the id and run the call the proxy saw as a notification
    ['{"jsonrpc":"2.0","ID":6,"method":"tools/call","params":{"name":"list_spaces","arguments":{}}}', null],
    ['{"jsonrpc":"2.0","id":7,"Method":"tools/call","params":{"name":"list_spaces","arguments":{}}}', null],
  ])("answers %s with an invalid-request error and runs nothing", async (line, id) => {
    const h = await connect();
    await h.initialize();

    h.send(line);
    const answer = await h.answer(id);

    expect(answer.error.code).toBeLessThanOrEqual(-32600);
    expect(heart!.requests).toHaveLength(1);
  });

  it("does not end a live session for a malformed initialize", async () => {
    const h = await connect({ tier: "small" });
    await h.initialize();

    h.send({ jsonrpc: "1.0", id: 5, method: "initialize", params: {} });
    await h.answer(5);

    expect(heart!.requests.map((r) => r.method)).toEqual(["POST"]);
    expect(heart!.sessions.size).toBe(1);
  });

  it("refuses a line past 8 MiB as it streams in", async () => {
    const h = await connect();

    h.input.write("x".repeat(9 * 1024 * 1024));
    const answer = await h.answer(null);
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" }); // ends the dropped line
    h.send({ jsonrpc: "2.0", id: 3, method: "ping" });

    expect(answer.error).toMatchObject({ code: -32600, message: expect.stringMatching(/larger than 8 MiB/) });
    expect((await h.answer(3)).result).toEqual({});
    expect(h.received.some((m) => m.id === 2)).toBe(false);
  });
});

describe("stdio proxy cancellation", () => {
  it("stops a call whose cancellation arrives in the same read, before it is sent", async () => {
    const call = vi.fn().mockResolvedValue({ content: [] });
    const h = await connect({ heart: { call } });
    await h.initialize();

    h.input.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } }) +
        "\n",
    );
    await h.request(3, "ping");
    await settle();

    expect(call).not.toHaveBeenCalled();
    expect(h.received.some((m) => m.id === 2)).toBe(false);
  });

  it("aborts a call in flight and does not answer it", async () => {
    let started!: () => void;
    const calling = new Promise<void>((resolve) => (started = resolve));
    // closed by the client before the fake had finished answering: 'close' alone also fires after a normal end
    let closedUnfinished = false;
    const h = await connect({
      heart: {
        intercept: async (request, res) => {
          if (!request.body.toString().includes('"tools/call"')) return false;
          started();
          res.on("close", () => (closedUnfinished = !res.writableFinished));
          await settle(150);
          if (!res.destroyed)
            res.writeHead(200, { "Content-Type": "application/json" }).end('{"jsonrpc":"2.0","id":2,"result":{}}');
          return true;
        },
      },
    });
    await h.initialize();

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } });
    await calling;
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "user" } });
    await settle(300);

    expect(closedUnfinished).toBe(true);
    expect(h.received.some((m) => m.id === 2)).toBe(false);
    expect(heart!.posted.map((m) => m.method)).not.toContain("notifications/cancelled");
  });
});

describe("stdio proxy failures", () => {
  it("fails initialize with a JSON-RPC error naming the key problem", async () => {
    const h = await connect({ headers: { Authorization: "Bearer wrong" } });

    const answer = await h.initialize();

    expect(answer.error.code).toBe(-32603);
    expect(answer.error.message).toMatch(/rejected the API key \(HTTP 401: invalid authorization header\)/);
  });

  it("answers every request with a configuration error, without calling Anytype", async () => {
    const h = await connect({ configError: "OPENAPI_MCP_HEADERS is not valid JSON" });

    const init = await h.initialize();
    const call = await h.request(2, "tools/call", { name: "list_spaces", arguments: {} });

    expect(init.error.message).toBe("OPENAPI_MCP_HEADERS is not valid JSON");
    expect(call.result).toMatchObject({ isError: true, content: [{ text: "OPENAPI_MCP_HEADERS is not valid JSON" }] });
    expect(heart!.requests).toHaveLength(0);
  });

  it("reports an unreachable Anytype in-band on tools/call, so the model can tell the user", async () => {
    const h = await connect();
    await h.initialize();
    await heart!.stop();
    heart = undefined;

    const answer = await h.request(2, "tools/call", { name: "list_spaces", arguments: {} });

    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toMatch(/Cannot reach Anytype at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
  });

  it("reports an unreachable Anytype as a JSON-RPC error on other methods", async () => {
    const h = await connect();
    await h.initialize();
    await heart!.stop();
    heart = undefined;

    const answer = await h.request(2, "tools/list");

    expect(answer.error).toMatchObject({ code: -32603, message: expect.stringMatching(/Cannot reach Anytype/) });
  });

  it("names the Anytype version /mcp needs and the pin for older ones", async () => {
    const h = await connect({ heart: { withoutMcp: true } });

    const answer = await h.initialize();

    expect(answer.error.message).toMatch(/heart >= 0\.51\.6.*pin @anyproto\/anytype-mcp@2\.0\.3/);
  });
});

describe("stdio proxy on a curated tier", () => {
  it("fails a tool call that met an expired session with the reason, and runs the next one", async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const h = await connect({ tier: "small", heart: { call } });
    await h.initialize();
    heart!.expireSessions();

    const expired = await h.request(2, "tools/call", { name: "list_spaces", arguments: {} });
    const next = await h.request(3, "tools/call", { name: "list_spaces", arguments: {} });

    expect(expired.result).toEqual({ content: [{ type: "text", text: SESSION_EXPIRED }], isError: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(next.result.content[0].text).toBe("ok");
  });

  it("answers every call received before stdin closed, then ends the session", async () => {
    const h = await connect({ tier: "large", heart: { call: async () => (await settle(100), { content: [] }) } });
    await h.initialize();

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } });
    h.input.end();
    await h.proxy.closed;

    expect(h.received.map((m) => m.id)).toEqual([1, 2]);
    expect(heart!.requests.map((r) => `${r.method} ${r.headers["mcp-session-id"] ?? "-"}`)).toEqual([
      "POST -",
      "POST session-1",
      "DELETE session-1",
    ]);
  });

  it("ends a session minted after stdin closed mid-initialize", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = await connect({
      tier: "small",
      heart: {
        intercept: async (request) => {
          if (request.body.toString().includes('"initialize"')) await gate;
          return false;
        },
      },
    });

    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await settle(30);
    h.input.end();
    setTimeout(release, 30);
    await h.proxy.closed;

    expect(heart!.requests.map((r) => r.method)).toEqual(["POST", "DELETE"]);
    expect(heart!.sessions.size).toBe(0);
  });

  it("cancels calls in flight on a signal, then ends the session", async () => {
    const h = await connect({ tier: "small", heart: { call: () => new Promise(() => {}) } });
    await h.initialize();

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } });
    await settle(50);
    await h.proxy.abort();

    expect(h.received.some((m) => m.id === 2)).toBe(false);
    expect(heart!.requests.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("stdio proxy, round 2 guards", () => {
  it("tells the next tool call about a reset a ping discovered, and never runs it in the new session", async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const h = await connect({ tier: "small", heart: { call } });
    await h.initialize();
    heart!.expireSessions();

    const pinged = await h.request(2, "ping");
    const told = await h.request(3, "tools/call", { name: "list_spaces", arguments: {} });
    const next = await h.request(4, "tools/call", { name: "list_spaces", arguments: {} });

    expect(pinged.result).toEqual({});
    expect(told.result).toEqual({ content: [{ type: "text", text: SESSION_EXPIRED }], isError: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(next.result.content[0].text).toBe("ok");
  });

  it("refuses a tool call queued behind a refused initialize, and ends the session Anytype minted", async () => {
    const call = vi.fn().mockResolvedValue({ content: [] });
    const h = await connect({ tier: "small", heart: { call } });

    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 42 } });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } });
    const refused = await h.answer(1);
    const queued = await h.answer(2);

    expect(refused.error.code).toBe(-32602);
    expect(queued.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/initialize did not succeed/) }],
    });
    expect(call).not.toHaveBeenCalled();
    expect(heart!.sessions.size).toBe(0);
  });

  it("starts nothing read after a signal, even while shutdown waits on earlier work", async () => {
    const h = await connect({
      heart: {
        intercept: async (request) => {
          if (request.body.toString().includes("notifications/slow")) await settle(200);
          return false;
        },
      },
    });
    await h.initialize();
    h.send({ jsonrpc: "2.0", method: "notifications/slow" });
    await settle(30);

    const aborting = h.proxy.abort();
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } });
    await aborting;
    await settle(50);

    expect(heart!.posted.some((m) => m.method === "tools/call")).toBe(false);
  });

  it("relays a valid result whose 25 MiB body Anytype carries twice", async () => {
    const big = "x".repeat(25 * 1024 * 1024);
    const h = await connect({
      heart: { call: async () => ({ content: [{ type: "text", text: big }], structuredContent: { body: big } }) },
    });
    await h.initialize();

    const answer = await h.request(2, "tools/call", { name: "list_spaces", arguments: {} });

    expect(answer.result.isError).toBeUndefined();
    expect(answer.result.content[0].text.length).toBe(big.length);
    expect(answer.result.structuredContent.body.length).toBe(big.length);
  }, 20_000);
});

describe("stdio proxy session resets (one state machine)", () => {
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  }
  const listSpaces = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "list_spaces", arguments: {} },
  });

  it("keeps the warning when the call that met the expiry is cancelled during the renewal", async () => {
    const hold = gate();
    let holding = false;
    let renewing!: () => void;
    const renewalStarted = new Promise<void>((resolve) => (renewing = resolve));
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const h = await connect({
      tier: "small",
      heart: {
        call,
        intercept: async (request) => {
          if (holding && request.body.toString().includes('"initialize"')) {
            renewing();
            await hold.opened;
          }
          return false;
        },
      },
    });
    await h.initialize();
    heart!.expireSessions();
    holding = true;

    h.send(listSpaces(2));
    await renewalStarted;
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    hold.open();
    const warned = await h.request(3, "tools/call", { name: "list_spaces", arguments: {} });
    const next = await h.request(4, "tools/call", { name: "list_spaces", arguments: {} });

    expect(h.received.some((m) => m.id === 2)).toBe(false);
    expect(warned.result.content[0].text).toBe(SESSION_EXPIRED);
    expect(next.result.content[0].text).toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not let an id-less tools/call take the warning", async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const h = await connect({ tier: "small", heart: { call } });
    await h.initialize();
    heart!.expireSessions();
    await h.request(2, "ping");

    h.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "list_spaces", arguments: {} } });
    await settle(50);
    const warned = await h.request(3, "tools/call", { name: "list_spaces", arguments: {} });

    expect(warned.result.content[0].text).toBe(SESSION_EXPIRED);
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses both of two calls that arrive while the renewal's notifications/initialized is pending", async () => {
    const hold = gate();
    let holding = false;
    let acking!: () => void;
    const ackPending = new Promise<void>((resolve) => (acking = resolve));
    const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const h = await connect({
      tier: "small",
      heart: {
        call,
        intercept: async (request) => {
          if (holding && request.body.toString().includes("notifications/initialized")) {
            acking();
            await hold.opened;
          }
          return false;
        },
      },
    });
    await h.initialize();
    heart!.expireSessions();
    holding = true;

    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    await ackPending;
    h.input.write(JSON.stringify(listSpaces(3)) + "\n" + JSON.stringify(listSpaces(4)) + "\n");
    await settle(50);
    hold.open();
    const [three, four] = [await h.answer(3), await h.answer(4)];
    const next = await h.request(5, "tools/call", { name: "list_spaces", arguments: {} });

    expect(three.result.content[0].text).toBe(SESSION_EXPIRED);
    expect(four.result.content[0].text).toBe(SESSION_EXPIRED);
    expect(next.result.content[0].text).toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not let a stalled notification hold back the DELETE on a signal", async () => {
    const h = await connect({
      tier: "small",
      heart: {
        intercept: async (request) => {
          if (request.body.toString().includes("notifications/initialized")) await settle(5_000);
          return false;
        },
      },
    });
    await h.initialize();
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle(50);

    const started = Date.now();
    await h.proxy.abort();

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(heart!.requests.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "session-1" } });
  }, 10_000);

  it("answers Anytype's HTTP 400 envelope error under the request's own id, without its data", async () => {
    const h = await connect({
      heart: {
        intercept: (request, res) => {
          if (!request.body.toString().includes('"ping"')) return false;
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "bad", data: { authorization: `Bearer ${FAKE_KEY}` } },
            }),
          );
          return true;
        },
      },
    });
    await h.initialize();

    const answer = await h.request(2, "ping");

    expect(answer).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32600, message: "bad" } });
    expect(h.lines.join("\n")).not.toContain(FAKE_KEY);
  });
});

describe("chooseVersion", () => {
  it("echoes what it carries, steps down to the newest older one otherwise, else keeps Anytype's", () => {
    expect(chooseVersion("2025-06-18", "2025-06-18")).toBe("2025-06-18");
    expect(chooseVersion("2024-11-05", "2025-11-25")).toBe("2024-11-05");
    expect(chooseVersion("2025-03-26", "2025-11-25")).toBe("2024-11-05");
    expect(chooseVersion("2099-01-01", "2025-11-25")).toBe("2025-11-25");
    expect(chooseVersion("2024-10-07", "2025-11-25")).toBe("2025-11-25");
    expect(chooseVersion(undefined, "2025-11-25")).toBe("2025-11-25");
  });
});
