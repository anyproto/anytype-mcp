// Delivery, renewal, shutdown and initialization edges (review rounds 4 and 5).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFailure, HeartClient, type HeartFailure } from "../heart-client";
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

  it("does not count a warning whose request was cancelled while its write was queued", async () => {
    const run = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const p = await proxy("small", { call: run });
    p.init();
    await settle();
    heart!.expireSessions();
    p.output.held = true;

    p.call(2); // refused: its warning is written, but held in the process
    await settle();
    // the host gives up on request 2 and will discard its answer unread
    p.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    await settle();
    p.output.release();
    await settle();
    p.call(3); // the client was never told: still refused
    await settle();
    p.call(4);
    await settle();

    expect(p.output.answer(3).result.content[0].text).toBe(SESSION_EXPIRED);
    expect(p.output.answer(4).result.content[0].text).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets a signal end the proxy while a warning's write never leaves the process", async () => {
    const p = await proxy("small");
    p.init();
    await settle();
    heart!.expireSessions();
    p.output.held = true;
    p.call(2); // its warning stays queued: the host is not reading
    await settle();

    const started = Date.now();
    await p.running.abort();

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(heart!.requests.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "session-2" } });
  }, 10_000);

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

  it("shuts down and ends the session once stdout fails, though stdin stays open", async () => {
    const p = await proxy("small");
    p.init();
    await settle();
    p.output.failing = true;

    p.call(2); // runs, but its answer cannot be written: the host stopped reading
    const closed = await Promise.race([p.running.closed.then(() => true), settle(1_500).then(() => false)]);

    expect(closed).toBe(true);
    expect(heart!.requests.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "session-1" } });
    expect(heart!.sessions.size).toBe(0);
  });
});

describe("a dispatched upload whose deadline passes before any answer", () => {
  it("is unconfirmed once the whole file was sent", async () => {
    // the whole upload is read; no answer comes before the deadline
    heart = await new FakeHeart({ intercept: (request) => request.path.endsWith("/files") }).start();
    dir = await mkdtemp(join(tmpdir(), "anytype-mcp-lifecycle-"));
    await writeFile(join(dir, "a.txt"), "x");
    const tools = new LocalFileTools({ baseUrl: heart.url, headers: auth, filesDir: dir, transferTimeoutMs: 200 });

    const result = await tools.call("upload_local_file", { space_id: "s", path: "a.txt" });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /^the upload outcome is unconfirmed: Anytype did not answer within \d+ minutes after the whole file was sent\. Check the space for the file before uploading it again\.$/,
    );
  });

  it("is still a plain unfinished transfer while the file was being sent", async () => {
    dir = await mkdtemp(join(tmpdir(), "anytype-mcp-lifecycle-"));
    await writeFile(join(dir, "a.txt"), "x");
    // takes the first part of the upload, then stalls until the deadline aborts it
    const stalled = (async (_url: unknown, init?: RequestInit) => {
      await (init!.body as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }) as typeof fetch;
    const tools = new LocalFileTools({
      baseUrl: "http://127.0.0.1:9",
      headers: auth,
      filesDir: dir,
      fetch: stalled,
      transferTimeoutMs: 100,
    });

    const result = await tools.call("upload_local_file", { space_id: "s", path: "a.txt" });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /^the transfer did not finish within \d+ minutes$/,
    );
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

  it.each([200, 204])(
    "is not acknowledged by an empty HTTP %i: the new session is ended, nothing replayed",
    async (status) => {
      let empty = false;
      heart = await new FakeHeart({
        intercept: (request, res) => {
          if (empty && request.body.toString().includes("notifications/initialized")) {
            res.writeHead(status).end();
            return true;
          }
          return false;
        },
      }).start();
      const client = new HeartClient({ baseUrl: heart.url, tier: "small", headers: auth });
      await client.send(
        msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      );
      heart.expireSessions();
      empty = true;

      const reply = await client.send(msg({ jsonrpc: "2.0", id: 2, method: "ping" }));

      expect(reply).toMatchObject({ kind: "failed", failure: { kind: "unreadable", status } });
      expect(heart.requests.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "session-2" } });
      expect(heart.posted.filter((m) => m.method === "ping")).toHaveLength(1);
    },
  );
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

  it("keeps a refusal's status when its body stalls past the deadline: a 401 is still a rejected key", async () => {
    heart = await new FakeHeart({
      intercept: (_request, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.write('{"object":"error","sta');
        return true;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "full", headers: auth, timeoutMs: 100 });

    const reply = await client.send(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));

    expect(reply).toEqual({
      kind: "failed",
      failure: { kind: "http", status: 401, message: undefined, routeMissing: false },
    });
  });

  it("makes a write whose HTTP 200 body broke an unconfirmed outcome, not 'cannot reach Anytype'", async () => {
    const p = await proxy("full", {
      intercept: (request, res) => {
        const method = JSON.parse(request.body.toString() || "{}").method;
        if (method !== "tools/call" && method !== "tools/list") return false;
        // Anytype ran the call and sent its 200; the connection broke mid-body
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"jsonrpc":"2.0","id":2,"res');
        setTimeout(() => res.destroy(), 20);
        return true;
      },
    });
    p.init();
    await settle();

    p.call(2, "add_chat_message", { chat_id: "c", text: "hi" });
    p.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    await settle();

    const answer = p.output.answer(2).result;
    expect(answer.isError).toBe(true);
    expect(answer.content[0].text).toMatch(/^Anytype answered HTTP 200, but its reply broke off before it was read\./);
    expect(answer.content[0].text).toMatch(/outcome is unconfirmed.*may have been applied.*before repeating it/);
    expect(answer.content[0].text).not.toMatch(/Cannot reach|start the Anytype app/);
    // not a tool call: a JSON-RPC error, with the same text
    expect(p.output.answer(3).error).toMatchObject({ code: -32603, message: expect.stringMatching(/unconfirmed/) });
  });

  it("makes a write whose HTTP 200 body stalled past the deadline an unconfirmed outcome", async () => {
    heart = await new FakeHeart({
      intercept: (request, res) => {
        if (!request.body.toString().includes('"tools/call"')) return false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"jsonrpc":"2.0","id":2,"res');
        return true;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "full", headers: auth, timeoutMs: 100 });

    const reply = await client.send(
      msg({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_chat_message", arguments: {} } }),
    );

    expect(reply).toEqual({ kind: "failed", failure: { kind: "lost", status: 200, ms: 100 } });
    expect(describeFailure((reply as { failure: HeartFailure }).failure, client)).toMatch(
      /^Anytype answered HTTP 200, but its reply did not finish within \d+ s\. The outcome is unconfirmed/,
    );
  });

  it("makes a call whose connection dropped after it was sent, before any answer, unconfirmed", async () => {
    heart = await new FakeHeart({
      intercept: (request, res) => {
        if (!request.body.toString().includes('"tools/call"')) return false;
        // the whole call has been read; the connection drops before any header
        res.destroy();
        return true;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "full", headers: auth });

    const reply = await client.send(
      msg({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_chat_message", arguments: {} } }),
    );

    expect(reply).toMatchObject({ kind: "failed", failure: { kind: "lost" } });
    expect(describeFailure((reply as { failure: HeartFailure }).failure, client)).toMatch(
      /^The connection to Anytype closed after the request was sent, before Anytype answered.*\. The outcome is unconfirmed/,
    );
  });

  it("reports a renewal whose answer broke off as a failure, not as an unconfirmed call: the call was not sent", async () => {
    let cut = false;
    heart = await new FakeHeart({
      intercept: (request, res) => {
        if (!cut || !request.body.toString().includes("anytype-mcp-renew")) return false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"jsonrpc":"2.0","id":"anytype-mcp-renew-1","res');
        setTimeout(() => res.destroy(), 20);
        return true;
      },
    }).start();
    const client = new HeartClient({ baseUrl: heart.url, tier: "small", headers: auth });
    await client.send(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    heart.expireSessions();
    cut = true;

    const reply = await client.send(
      msg({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_spaces", arguments: {} } }),
    );

    expect(reply).toEqual({
      kind: "failed",
      failure: { kind: "unreadable", status: 200, detail: "the reply was cut off" },
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

  it("cuts a stalled first initialize short on a signal and ends the session whose id arrived", async () => {
    let headersSent!: () => void;
    const sent = new Promise<void>((resolve) => (headersSent = resolve));
    const p = await proxy("small", {
      intercept: (request, res) => {
        if (!request.body.toString().includes('"initialize"')) return false;
        heart!.sessions.set("held", "small");
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "held" });
        res.write('{"jsonrpc":"2.0","id":1,"res');
        headersSent();
        return true;
      },
    });
    p.init();
    await sent;
    await settle(50); // the headers reach the proxy

    const started = Date.now();
    await p.running.abort();

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(heart!.requests.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "held" } });
    expect(heart!.sessions.size).toBe(0);
  }, 10_000);
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
