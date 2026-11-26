import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tier } from "../config";
import { startStdioProxy, type LegacyFallback, type RunningProxy } from "../stdio-proxy";
import { DEFAULT_TOOLS, FAKE_KEY, FakeHeart, type FakeHeartOptions } from "./fake-heart";

const auth = { Authorization: `Bearer ${FAKE_KEY}` };

/** A host on the other end of stdio: writes lines, waits for answers. */
class Host {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly received: Array<Record<string, any>> = [];
  readonly logs: string[] = [];
  private waiters: Array<() => void> = [];
  proxy!: RunningProxy;

  constructor() {
    createInterface({ input: this.output }).on("line", (line) => {
      this.received.push(JSON.parse(line));
      this.waiters.forEach((wake) => wake());
    });
  }

  send(message: unknown) {
    this.input.write(JSON.stringify(message) + "\n");
  }

  /** The first received message matching, waiting for it if needed. */
  async waitFor(match: (m: Record<string, any>) => boolean, timeoutMs = 2000): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching message; received ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  answer(id: number | string) {
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

let heart: FakeHeart | undefined;
let host: Host | undefined;
afterEach(async () => {
  host?.input.end();
  await host?.proxy.closed;
  await heart?.stop();
  heart = undefined;
  host = undefined;
});

async function connect(
  options: {
    tier?: Tier;
    heart?: FakeHeartOptions;
    headers?: Record<string, string>;
    legacyFallback?: LegacyFallback;
    baseUrl?: string;
  } = {},
) {
  heart = await new FakeHeart(options.heart).start();
  host = new Host();
  host.proxy = startStdioProxy({
    baseUrl: options.baseUrl ?? heart.url,
    tier: options.tier ?? "full",
    headers: options.headers ?? auth,
    input: host.input,
    output: host.output,
    log: (line) => host!.logs.push(line),
    legacyFallback: options.legacyFallback,
  });
  return host;
}

describe("stdio proxy over /mcp/full", () => {
  it("passes initialize through, Anytype's instructions and server info included", async () => {
    const h = await connect();

    const answer = await h.initialize("2025-06-18");

    expect(answer).toEqual({
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

  it("answers an older client with its own revision while speaking Anytype's on HTTP", async () => {
    const h = await connect();

    const answer = await h.initialize("2025-03-26");
    await h.request(2, "tools/list");

    expect(answer.result.protocolVersion).toBe("2025-03-26");
    expect(heart!.requests[1].headers["mcp-protocol-version"]).toBe("2025-11-25");
  });

  it("leaves a revision it does not know to the client", async () => {
    const h = await connect();

    const answer = await h.initialize("2099-01-01");

    expect(answer.result.protocolVersion).toBe("2025-11-25");
  });

  it("lists Anytype's tools unchanged, with the two local file tools after them", async () => {
    const h = await connect();
    await h.initialize();

    const answer = await h.request(2, "tools/list");

    const names = answer.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["list_spaces", "upload_file", "download_file", "upload_local_file"]);
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

  it("forwards tools/call and relays the result untouched", async () => {
    const result = {
      content: [{ type: "text", text: '{"spaces":[]}' }],
      structuredContent: { spaces: [] },
      _meta: { extra: true },
    };
    const call = vi.fn().mockResolvedValue(result);
    const h = await connect({ heart: { call } });
    await h.initialize();

    const answer = await h.request(2, "tools/call", { name: "list_spaces", arguments: { limit: 3 } });

    expect(answer).toEqual({ jsonrpc: "2.0", id: 2, result });
    expect(call).toHaveBeenCalledWith("list_spaces", { limit: 3 });
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

  it("aborts a cancelled call and does not answer it", async () => {
    let started!: () => void;
    const calling = new Promise<void>((resolve) => (started = resolve));
    const answerAfterMs = 150;
    const h = await connect({
      heart: {
        call: async () => {
          started();
          await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
          return { content: [{ type: "text", text: "too late" }] };
        },
      },
    });
    await h.initialize();

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } });
    await calling;
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "user" } });
    await h.request(3, "ping");
    // long enough for the uncancelled answer to have arrived
    await new Promise((resolve) => setTimeout(resolve, answerAfterMs * 2));

    expect(h.received.some((m) => m.id === 2)).toBe(false);
    // the cancellation is the proxy's to act on; Anytype has no stream to cancel on
    expect(heart!.posted.map((m) => m.method)).not.toContain("notifications/cancelled");
  });

  it("answers a line that is not JSON with a parse error", async () => {
    const h = await connect();

    h.input.write("{not json\n");

    expect(await h.answer(null as any)).toMatchObject({ error: { code: -32700 } });
  });

  it("relays Anytype's refusal of a batch", async () => {
    const h = await connect();
    await h.initialize();

    h.send([{ jsonrpc: "2.0", id: 5, method: "ping" }]);

    expect(await h.waitFor((m) => m.error?.code === -32600)).toMatchObject({ id: null });
  });
});

describe("stdio proxy failures", () => {
  it("fails initialize with a JSON-RPC error naming the key problem", async () => {
    const h = await connect({ headers: { Authorization: "Bearer wrong" } });

    const answer = await h.initialize();

    expect(answer.error.code).toBe(-32603);
    expect(answer.error.message).toMatch(/rejected the API key \(HTTP 401: invalid authorization header\)/);
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

  it("tells the user to update an Anytype without /mcp when no fallback is configured", async () => {
    const h = await connect({ heart: { withoutMcp: true } });

    const answer = await h.initialize();

    expect(answer.error.message).toMatch(/predates its built-in MCP server.*update the Anytype app/);
  });

  it("hands an Anytype without /mcp to the fallback, initialize included", async () => {
    const sent: unknown[] = [];
    const fallback: LegacyFallback = async (deliver) => async (message: any) => {
      sent.push(message);
      if (message.id !== undefined) deliver({ jsonrpc: "2.0", id: message.id, result: { from: "legacy" } });
    };
    const h = await connect({ heart: { withoutMcp: true }, legacyFallback: fallback });

    const initialized = await h.initialize();
    const listed = await h.request(2, "tools/list");

    expect(initialized.result).toEqual({ from: "legacy" });
    expect(listed.result).toEqual({ from: "legacy" });
    expect(sent.map((m: any) => m.method)).toEqual(["initialize", "tools/list"]);
    expect(heart!.posted.map((m) => m.method)).toEqual(["initialize"]);
    expect(h.logs.join("\n")).toMatch(/predates its built-in MCP server\. Falling back/);
  });

  it("does not fall back when Anytype is merely unreachable", async () => {
    const fallback = vi.fn<LegacyFallback>();
    const h = await connect({ legacyFallback: fallback });
    await heart!.stop();
    heart = undefined;

    const answer = await h.initialize();

    expect(answer.error.message).toMatch(/Cannot reach Anytype/);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("stdio proxy on a curated tier", () => {
  it("carries the session and ends it when stdin closes", async () => {
    const h = await connect({ tier: "large" });
    await h.initialize();
    await h.request(2, "tools/list");

    h.input.end();
    await h.proxy.closed;

    expect(heart!.requests.map((r) => `${r.method} ${r.headers["mcp-session-id"] ?? "-"}`)).toEqual([
      "POST -",
      "POST session-1",
      "DELETE session-1",
    ]);
  });

  it("re-opens an expired session without the client noticing", async () => {
    const h = await connect({ tier: "small" });
    await h.initialize();
    heart!.expireSessions();

    const answer = await h.request(2, "tools/list");

    expect(answer.result.tools).toBeDefined();
    expect(h.received.map((m) => m.id)).toEqual([1, 2]);
  });
});
