// Delivery, renewal, shutdown and initialization edges (review round 4).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeartClient } from "../heart-client";
import { classify, type Inbound } from "../jsonrpc";
import { LocalFileTools } from "../local-tools";
import { SESSION_EXPIRED, startStdioProxy } from "../stdio-proxy";
import { FAKE_KEY, FakeHeart, type FakeHeartOptions } from "./fake-heart";

const auth = { Authorization: `Bearer ${FAKE_KEY}` };
const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const msg = (value: unknown) => classify(JSON.stringify(value)) as Inbound;
let heart: FakeHeart | undefined;
let dir = "";
afterEach(async () => {
  await heart?.stop();
  heart = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

/** A stdout whose writes can be held (not yet out of the process) or made to fail. */
class TestOutput extends Writable {
  held = false;
  failing = false;
  readonly lines: string[] = [];
  private pending: Array<() => void> = [];
  private buffer = "";
  _write(chunk: Buffer, _encoding: string, done: (error?: Error) => void) {
    if (this.failing) return done(new Error("EPIPE: the host went away"));
    const deliver = () => {
      this.buffer += chunk.toString();
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        this.lines.push(this.buffer.slice(0, i));
        this.buffer = this.buffer.slice(i + 1);
      }
      done();
    };
    if (this.held) this.pending.push(deliver);
    else deliver();
  }
  release() {
    this.held = false;
    this.pending.splice(0).forEach((deliver) => deliver());
  }
  answer(id: number) {
    return this.lines.map((line) => JSON.parse(line)).find((m) => m.id === id);
  }
}

async function proxy(tier: "full" | "small", options: FakeHeartOptions = {}) {
  heart = await new FakeHeart(options).start();
  dir = await mkdtemp(join(tmpdir(), "anytype-mcp-lifecycle-"));
  const input = new PassThrough();
  const output = new TestOutput();
  output.on("error", () => {});
  const running = startStdioProxy({
    baseUrl: heart.url,
    tier,
    headers: auth,
    input,
    output,
    log: () => {},
    filesDir: dir,
  });
  const send = (message: unknown) => input.write(JSON.stringify(message) + "\n");
  const call = (id: number, name = "list_spaces", args: Record<string, unknown> = {}) =>
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const init = () => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  return { input, output, running, send, call, init };
}

describe("a session reset is delivered only once its warning has left the process", () => {
  it("keeps refusing tool calls while the warning's write is still queued", async () => {
    const run = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const p = await proxy("small", { call: run });
    p.init();
    await settle();
    heart!.expireSessions();
    p.output.held = true;

    p.call(2); // refused: its warning is written, but held in the process
    await settle();
    p.call(3); // arrived before the warning left the process
    await settle();
    const ranWhileHeld = run.mock.calls.length;
    p.output.release();
    await settle();
    p.call(4);
    await settle();

    expect(ranWhileHeld).toBe(0);
    expect(p.output.answer(2).result.content[0].text).toBe(SESSION_EXPIRED);
    expect(p.output.answer(3).result.content[0].text).toBe(SESSION_EXPIRED);
    expect(p.output.answer(4).result.content[0].text).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("starts nothing more once a stdout write has failed", async () => {
    const run = vi.fn().mockResolvedValue({ content: [] });
    const p = await proxy("full", { call: run });
    p.init();
    await settle();
    p.output.failing = true;

    p.call(2); // runs, but its answer cannot be written
    await settle();
    p.call(3); // the host can no longer be answered: not started
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(heart!.posted.filter((m) => m.method === "tools/call").map((m) => m.id)).toEqual([2]);
  });
});

describe("a renewal's notifications/initialized", () => {
  it("is cut short by a signal, and the new session is ended", async () => {
    let holding = false;
    let acking!: () => void;
    const ackPending = new Promise<void>((resolve) => (acking = resolve));
    const p = await proxy("small", {
      intercept: async (request) => {
        if (holding && request.body.toString().includes("notifications/initialized")) {
          acking();
          await settle(5_000);
        }
        return false;
      },
    });
    p.init();
    await settle();
    heart!.expireSessions();
    holding = true;
    p.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    await ackPending;

    const started = Date.now();
    await p.running.abort();

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(heart!.requests.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "session-2" } });
  }, 10_000);

  it("must be acknowledged with 202: a refusal ends the new session and fails the renewal", async () => {
    let refuse = false;
    heart = await new FakeHeart({
      intercept: (request, res) => {
        if (refuse && request.body.toString().includes("notifications/initialized")) {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"not now"}}');
          return true;
        }
        return false;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "small", headers: auth });
    await client.send(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    heart.expireSessions();
    refuse = true;

    const reply = await client.send(msg({ jsonrpc: "2.0", id: 2, method: "ping" }));

    expect(reply).toEqual({ kind: "failed", failure: { kind: "rejected", message: "not now" } });
    expect(heart.requests.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "session-2" } });
    expect(heart.posted.filter((m) => m.method === "ping")).toHaveLength(1);
  });
});

describe("a credential straddling the 300-character cut", () => {
  // the configured key ("test-key") starts at 296: a cut at 300 before redaction would leave "test"
  const message = "a".repeat(296) + FAKE_KEY;

  it("leaks no fragment from Anytype's HTTP 400 envelope error", async () => {
    heart = await new FakeHeart({
      intercept: (_request, res) => {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }));
        return true;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "full", headers: auth });

    const reply = await client.send(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));

    expect(reply).toMatchObject({ kind: "rpcError", message: `${"a".repeat(296)}[red…` });
    expect(JSON.stringify(reply)).not.toContain("test");
  });

  it("leaks no fragment from a refused renewal", async () => {
    let refuse = false;
    heart = await new FakeHeart({
      intercept: (request, res) => {
        if (!refuse || !request.body.toString().includes('"initialize"')) return false;
        const id = /"id":("[^"]+")/.exec(request.body.toString())![1];
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(`{"jsonrpc":"2.0","id":${id},"error":{"code":-32602,"message":${JSON.stringify(message)}}}`);
        return true;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "small", headers: auth });
    await client.send(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    heart.expireSessions();
    refuse = true;

    const reply = await client.send(msg({ jsonrpc: "2.0", id: 2, method: "ping" }));

    expect(reply).toMatchObject({ kind: "failed", failure: { kind: "rejected" } });
    expect(JSON.stringify(reply)).not.toContain("test");
  });
});

describe("a body that breaks off", () => {
  it("keeps a refusal's status: a 401 is still a rejected key", async () => {
    heart = await new FakeHeart({
      intercept: (_request, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.write('{"object":"error","sta');
        setTimeout(() => res.destroy(), 20);
        return true;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "full", headers: auth });

    const reply = await client.send(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));

    expect(reply).toEqual({
      kind: "failed",
      failure: { kind: "http", status: 401, message: undefined, routeMissing: false },
    });
  });

  it("makes a 201 upload receipt unconfirmed, not a failed transfer", async () => {
    heart = await new FakeHeart({
      intercept: (request, res) => {
        if (!request.path.endsWith("/files")) return false;
        res.writeHead(201, { "Content-Type": "application/json" });
        res.write('{"id":"ba');
        setTimeout(() => res.destroy(), 20);
        return true;
      },
    }).start();
    dir = await mkdtemp(join(tmpdir(), "anytype-mcp-lifecycle-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tools = new LocalFileTools({ baseUrl: heart.url, headers: auth, filesDir: dir });

    const result = await tools.call("upload_local_file", { space_id: "s", path: "a.txt" });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /upload outcome is unconfirmed: Anytype answered HTTP 201/,
    );
  });
});

describe("an upload whose connection closes before any answer", () => {
  it("is unconfirmed once the body was sent, not unreachable", async () => {
    heart = await new FakeHeart({
      intercept: (request, res) => {
        if (!request.path.endsWith("/files")) return false;
        // the whole upload has been read; the connection drops before any header
        res.destroy();
        return true;
      },
    }).start();
    dir = await mkdtemp(join(tmpdir(), "anytype-mcp-lifecycle-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tools = new LocalFileTools({ baseUrl: heart.url, headers: auth, filesDir: dir });

    const result = await tools.call("upload_local_file", { space_id: "s", path: "a.txt" });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /upload outcome is unconfirmed: the connection to Anytype closed before it answered\. Check the space/,
    );
  });
});

describe("shutdown", () => {
  it("makes a signal after stdin ended wait for the DELETE the end started", async () => {
    let deleted = false;
    const p = await proxy("small", {
      intercept: async (request) => {
        if (request.method === "DELETE") {
          await settle(300);
          deleted = true;
        }
        return false;
      },
    });
    p.init();
    await settle();

    p.input.end();
    await settle(30);
    await p.running.abort();

    expect(deleted).toBe(true);
  });
});

describe("nothing but ping runs before a successful initialize", () => {
  it("refuses a tool call after a malformed first initialize", async () => {
    const run = vi.fn().mockResolvedValue({ content: [] });
    const p = await proxy("full", { call: run });

    p.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: null });
    await settle();
    p.call(2);
    await settle();

    expect(p.output.answer(1).error.code).toBe(-32600);
    expect(p.output.answer(2).result.content[0].text).toMatch(/send initialize/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a local file tool without initialize, and answers ping", async () => {
    const p = await proxy("full", { files: { f: { name: "a.txt", type: "text/plain", bytes: Buffer.from("x") } } });

    p.call(2, "download_file", { space_id: "s", file_id: "f" });
    p.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    await settle();

    expect(p.output.answer(2).result.isError).toBe(true);
    expect(heart!.requests.some((r) => r.path.includes("/files/"))).toBe(false);
    expect(p.output.answer(3).result).toEqual({});
  });
});
