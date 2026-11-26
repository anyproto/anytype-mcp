// The stdio half of the proxy. Hosts whose configuration only launches
// commands (Claude Desktop among them) attach here; each newline-delimited
// JSON-RPC message from stdin goes to Anytype's /mcp/{tier} byte for byte, and
// what Anytype answers comes back on stdout byte for byte. The proxy adds only
// what a process boundary needs:
//
// - a message Anytype would refuse as malformed is refused here first, so
//   nothing below runs on it;
// - errors Anytype cannot send (unreachable, key rejected) become a JSON-RPC
//   error, or an in-band tool error on tools/call so the model can tell the user;
// - the stdio connection negotiates its own protocol revision;
// - notifications/cancelled stops the call it names, even one not yet sent;
// - on the full tier, two local file tools (local-tools.ts).

import type { Readable, Writable } from "node:stream";
import { DEFAULT_BASE_URL, type Tier } from "./config";
import { describeFailure, HeartClient, idOf, initializeSucceeded, type HeartReply } from "./heart-client";
import {
  classify,
  frameError,
  frameResult,
  idKey,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  isObject,
  MAX_MESSAGE_BYTES,
  rawMember,
  sameId,
  toolError,
  type Inbound,
  type JsonObject,
} from "./jsonrpc";
import { LocalFileTools } from "./local-tools";

/**
 * Revisions the stdio side answers with. Anytype's HTTP server speaks
 * 2025-06-18 and 2025-11-25; for a tools-only server the older ones differ in
 * optional fields an older client ignores (Anytype's own stdio server echoes
 * them too). 2025-03-26 is left out: it requires accepting JSON-RPC batches,
 * which Anytype refuses, so its clients are answered with 2024-11-05.
 */
export const STDIO_PROTOCOL_VERSIONS = ["2024-11-05", "2025-06-18", "2025-11-25"];

/** The client's revision when the proxy carries it, else the newest one not newer than it, else Anytype's. */
export function chooseVersion(asked: unknown, answered: string): string {
  if (typeof asked !== "string") return answered;
  if (STDIO_PROTOCOL_VERSIONS.includes(asked)) return asked;
  // revisions are dates, so string order is age order
  const older = STDIO_PROTOCOL_VERSIONS.filter((version) => version < asked);
  return older.at(-1) ?? answered;
}

export const SESSION_EXPIRED =
  "The Anytype session expired (Anytype ends a session idle for 30 minutes) and a new one was opened, so " +
  "numbered results and handles from before no longer exist. This call was not run. Re-read your targets " +
  "(run spaces or find again) and retry with the new numbers.";

export interface StdioProxyOptions {
  heart: HeartClient;
  /** Served beside Anytype's tools; the full tier only. */
  localTools?: LocalFileTools;
  /** A configuration the proxy cannot run with: every request is answered with it. */
  configError?: string;
  log?: (line: string) => void;
}

interface Pending {
  controller: AbortController;
  done: Promise<void>;
}

export class StdioProxy {
  private readonly heart: HeartClient;
  private readonly pending = new Map<string, Pending>();
  private readonly log: (line: string) => void;
  /** Settles once the latest initialize has been answered; everything else waits for it. */
  private ready: Promise<void> = Promise.resolve();
  private readonly work = new Set<Promise<void>>();
  /** Aborts forwarded notifications and responses on a signal (stdin EOF drains them instead). */
  private readonly shutdown = new AbortController();
  /** False once shutdown has begun: later frames are dropped, not started. */
  private accepting = true;
  /** How the latest initialize went; after a refused one, only ping and initialize are served. */
  private initialization: "none" | "succeeded" | "failed" = "none";

  constructor(
    private readonly options: StdioProxyOptions,
    private readonly write: (line: string) => void,
  ) {
    this.heart = options.heart;
    this.log = options.log ?? (() => {});
  }

  /**
   * One line from the client. Everything up to the first await runs now, in
   * arrival order: a request is registered before a cancellation behind it in
   * the same read can look for it.
   */
  receive(line: string): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const message = classify(line);
    if (message.kind === "invalid") {
      this.write(frameError(message.id, message.code, message.message));
      return Promise.resolve();
    }
    if (this.options.configError) {
      if (message.kind === "request") this.fail(message, this.options.configError);
      return Promise.resolve();
    }
    if (message.kind === "notification" && message.method === "notifications/cancelled") {
      // the proxy acts on it; Anytype answers one POST per call and has nothing to cancel
      const params = rawMember(message.raw, "params");
      const id = params ? rawMember(params, "requestId") : undefined;
      if (id && /^(?:"|-?\d)/.test(id)) this.pending.get(idKey(id))?.controller.abort();
      return Promise.resolve();
    }
    if (message.kind === "request" && message.method === "initialize") {
      const answered = this.ready.then(() => this.initialize(message));
      this.ready = answered.catch(() => {});
      return this.track(answered);
    }
    if (message.kind === "request") {
      const key = idKey(message.id!);
      const controller = new AbortController();
      // which session resets the client had been told about when this call arrived
      const seenDelivered = this.heart.deliveredResets;
      const done = this.ready
        .then(() => (controller.signal.aborted ? undefined : this.request(message, controller.signal, seenDelivered)))
        .finally(() => {
          if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
        });
      this.pending.set(key, { controller, done });
      return this.track(done);
    }
    return this.track(this.ready.then(() => this.forward(message)));
  }

  /** Refuses a line past Anytype's size bound without having held it in memory. */
  oversized(): void {
    this.write(
      frameError(
        "null",
        INVALID_REQUEST,
        `message larger than ${MAX_MESSAGE_BYTES >> 20} MiB, the most Anytype accepts`,
      ),
    );
  }

  /**
   * Shuts down: by default every call already received is answered first
   * (stdin closing is how a host ends the session); with abort, calls in
   * flight are cancelled (a signal). Either way a download in progress
   * removes its partial file and the session is ended.
   */
  async close({ abort = false } = {}): Promise<void> {
    this.stop();
    if (abort) {
      this.pending.forEach((p) => p.controller.abort());
      // notifications and client responses too, so a stalled one cannot hold back the DELETE
      this.shutdown.abort();
    }
    await Promise.allSettled([...this.work]);
    await this.heart.close();
  }

  /** Accepts no further frames; work already accepted carries on. Synchronous, for a signal handler. */
  stop(): void {
    this.accepting = false;
  }

  private track(promise: Promise<void>): Promise<void> {
    this.work.add(promise);
    void promise.finally(() => this.work.delete(promise)).catch(() => {});
    return promise;
  }

  private async initialize(request: Inbound): Promise<void> {
    const reply = await this.heart.send(request);
    this.initialization = initializeSucceeded(reply, request.id!) ? "succeeded" : "failed";
    this.relay(request, reply, (result) => {
      if (typeof result.protocolVersion !== "string") return undefined;
      const version = chooseVersion(request.params?.protocolVersion, result.protocolVersion);
      return version === result.protocolVersion ? undefined : { ...result, protocolVersion: version };
    });
  }

  private async request(request: Inbound, signal: AbortSignal, seenDelivered: number): Promise<void> {
    if (this.initialization === "failed" && request.method !== "ping") {
      // a call queued behind a refused initialize must not run (MCP lifecycle)
      this.fail(request, "initialize did not succeed; send initialize again before other requests");
      return;
    }
    const local = this.localCall(request);
    if (local) {
      const result = await local(signal).catch(() => toolError("the local file tool failed"));
      if (!signal.aborted) this.write(frameResult(request.id!, result));
      return;
    }
    const reply = await this.heart.send(request, signal, seenDelivered);
    // a cancelled request is not answered (MCP cancellation)
    if (signal.aborted) return;
    this.relay(request, reply, request.method === "tools/list" ? (result) => this.withLocalTools(result) : undefined);
  }

  private localCall(request: Inbound): ((signal: AbortSignal) => Promise<JsonObject>) | undefined {
    const tools = this.options.localTools;
    const params = request.params;
    if (request.method !== "tools/call" || !tools || typeof params?.name !== "string") return undefined;
    if (!tools.serves(params.name)) return undefined;
    const name = params.name;
    const args = isObject(params.arguments) ? params.arguments : {};
    return (signal) => tools.call(name, args, signal);
  }

  /** Notifications and client responses: Anytype acknowledges them; anything it answers is passed on. */
  private async forward(message: Inbound): Promise<void> {
    const reply = await this.heart.send(message, this.shutdown.signal);
    if (reply.kind === "messages") reply.messages.forEach((m) => this.write(m.raw));
    if (reply.kind === "rpcError") this.log(`Anytype refused ${message.method ?? "a response"}: ${reply.message}`);
    if (reply.kind === "failed") {
      this.log(
        `could not deliver ${message.method ?? "a response"} to Anytype: ${describeFailure(reply.failure, this.heart)}`,
      );
    }
  }

  /**
   * Writes Anytype's answer as it came. Only an answer the proxy must change
   * (transform returns a new result) is re-encoded, under the request's own id.
   */
  private relay(request: Inbound, reply: HeartReply, transform?: (result: JsonObject) => JsonObject | undefined): void {
    switch (reply.kind) {
      case "cancelled":
        return;
      case "accepted":
        this.fail(request, "Anytype accepted the request without answering it");
        return;
      case "sessionExpired":
        // relay runs only for a live (not cancelled) request: the warning is written now, so the client knows
        this.fail(request, SESSION_EXPIRED);
        this.heart.acknowledgeReset(reply.generation);
        return;
      case "rpcError":
        this.write(frameError(request.id!, reply.code, reply.message));
        return;
      case "failed":
        this.fail(request, describeFailure(reply.failure, this.heart));
        return;
      case "messages": {
        let answered = false;
        for (const message of reply.messages) {
          const id = idOf(message);
          const isAnswer = "result" in message.parsed || "error" in message.parsed;
          if (isAnswer && id === "null" && isObject(message.parsed.error)) {
            // one message per POST: an error Anytype could not attribute is about this request
            answered = true;
            this.write(`{"jsonrpc":"2.0","id":${request.id},"error":${JSON.stringify(message.parsed.error)}}`);
            continue;
          }
          if (isAnswer && id !== undefined && sameId(id, request.id!)) {
            answered = true;
            const changed = isObject(message.parsed.result) ? transform?.(message.parsed.result) : undefined;
            this.write(changed ? frameResult(request.id!, changed) : message.raw);
            continue;
          }
          this.write(message.raw);
        }
        if (!answered) this.fail(request, "Anytype's reply did not answer the request");
        return;
      }
    }
  }

  private withLocalTools(result: JsonObject): JsonObject | undefined {
    const tools = this.options.localTools;
    if (!tools || !Array.isArray(result.tools)) return undefined;
    const served = new Set(
      result.tools.map((tool: unknown) => (isObject(tool) && typeof tool.name === "string" ? tool.name : "")),
    );
    const local = tools.listing(served);
    return local.length === 0 ? undefined : { ...result, tools: [...result.tools, ...local] };
  }

  /** A failure the proxy reports itself: in-band on tools/call, a JSON-RPC error elsewhere. */
  private fail(request: Inbound, text: string): void {
    if (request.method === "tools/call") this.write(frameResult(request.id!, toolError(text)));
    else this.write(frameError(request.id!, INTERNAL_ERROR, text));
  }
}

/**
 * Splits stdin into lines without holding more than maxBytes of one: a longer
 * line is dropped as it streams in and reported once. stop() takes no
 * further lines, synchronously.
 */
export function readLines(
  input: Readable,
  onLine: (line: string) => void,
  onOversized: () => void,
  maxBytes = MAX_MESSAGE_BYTES,
): { ended: Promise<void>; stop(): void } {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;
  let stopped = false;
  const emit = () => {
    const line = Buffer.concat(parts).toString("utf8").replace(/\r$/, "");
    if (!stopped && line.trim() !== "") onLine(line);
  };
  const onData = (data: Buffer | string) => {
    const chunk = typeof data === "string" ? Buffer.from(data) : data;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!dropping && end > start) {
        size += end - start;
        if (size > maxBytes) {
          dropping = true;
          parts = [];
          onOversized();
        } else {
          parts.push(chunk.subarray(start, end));
        }
      }
      if (newline === -1) return;
      if (!dropping) emit();
      parts = [];
      size = 0;
      dropping = false;
      start = newline + 1;
    }
  };
  input.on("data", onData);
  const ended = new Promise<void>((resolve) => {
    const finish = () => {
      if (!dropping && parts.length > 0) emit();
      parts = [];
      resolve();
    };
    input.once("end", finish);
    input.once("error", finish);
  });
  return {
    ended,
    stop() {
      stopped = true;
      input.off("data", onData);
      input.pause();
    },
  };
}

export interface StartOptions {
  baseUrl?: string;
  tier?: Tier;
  headers?: Record<string, string>;
  filesDir?: string;
  configError?: string;
  input?: Readable;
  output?: Writable;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export interface RunningProxy {
  /** Resolves when stdin has ended, every call received has been answered, and the session is closed. */
  closed: Promise<void>;
  /** Cancels calls in flight and closes the session (for a signal). */
  abort(): Promise<void>;
}

/** Wires stdin and stdout to Anytype's /mcp/{tier}. */
export function startStdioProxy(options: StartOptions): RunningProxy {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => console.error(line));
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const tier = options.tier ?? "full";
  const headers = options.headers ?? {};
  const heart = new HeartClient({ baseUrl, tier, headers, fetch: options.fetch });
  const localTools =
    tier === "full" && options.filesDir
      ? new LocalFileTools({ baseUrl, headers, filesDir: options.filesDir, fetch: options.fetch })
      : undefined;
  // the host going away mid-answer is not an error worth crashing on
  output.on("error", (error) => log(`stdout: ${error.message}`));
  const proxy = new StdioProxy({ heart, localTools, configError: options.configError, log }, (line) => {
    output.write(line + "\n");
  });

  const reader = readLines(
    input,
    (line) =>
      void proxy.receive(line).catch((error) => log(`anytype-mcp: ${error instanceof Error ? error.message : error}`)),
    () => proxy.oversized(),
  );
  let aborted!: () => void;
  const abortDone = new Promise<void>((resolve) => (aborted = resolve));
  const abort = async () => {
    // nothing read after this moment starts: the frames are not even parsed
    reader.stop();
    proxy.stop();
    await proxy.close({ abort: true });
    aborted();
  };
  const closed = Promise.race([reader.ended.then(() => proxy.close()), abortDone]);
  return { closed, abort };
}
