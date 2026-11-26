// The stdio half of the proxy. Hosts whose configuration only launches
// commands (Claude Desktop among them) attach here; each newline-delimited
// JSON-RPC message from stdin goes to Anytype's /mcp/{tier} as it is, and what
// Anytype answers comes back on stdout as it is. The proxy adds only what a
// process boundary needs:
//
// - errors Anytype cannot send (unreachable, key rejected) become a JSON-RPC
//   error, or an in-band tool error on tools/call so the model can tell the user;
// - the stdio connection negotiates its own protocol revision: Anytype's HTTP
//   server speaks 2025-06-18 and 2025-11-25, a stdio client may ask for an older
//   one, and the tools surface is the same in each (Anytype's own stdio server
//   echoes those older revisions too);
// - notifications/cancelled aborts the forwarded call instead of being sent on;
// - on the full tier, two local file tools (local-tools.ts);
// - optionally, a fallback for an Anytype that predates /mcp.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Tier } from "./config";
import { describeFailure, HeartClient, type HeartReply } from "./heart-client";
import {
  errorResponse,
  INTERNAL_ERROR,
  isNotification,
  isObject,
  isRequest,
  PARSE_ERROR,
  resultResponse,
  toolError,
  type JsonObject,
  type Request,
  type RequestId,
} from "./jsonrpc";
import { LocalFileTools } from "./local-tools";

/**
 * Revisions the stdio side may answer with. Each published revision up to
 * the newest Anytype speaks: for a tools-only server they differ in optional
 * fields (annotations, structuredContent) an older client ignores.
 */
export const STDIO_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/**
 * Starts serving messages from another server once Anytype turned out not to
 * have /mcp: deliver carries that server's messages to stdout; the function
 * returned sends a client message to it.
 */
export type LegacyFallback = (deliver: (message: unknown) => void) => Promise<(message: unknown) => Promise<void>>;

export interface StdioProxyOptions {
  heart: HeartClient;
  tier: Tier;
  /** Served beside Anytype's tools; the full tier only. */
  localTools?: LocalFileTools;
  legacyFallback?: LegacyFallback;
  log?: (line: string) => void;
}

export class StdioProxy {
  private readonly heart: HeartClient;
  private readonly inflight = new Map<RequestId, AbortController>();
  private readonly log: (line: string) => void;
  /** Settles once the latest initialize has been answered; everything else waits for it. */
  private ready: Promise<void> = Promise.resolve();
  private legacy?: (message: unknown) => Promise<void>;

  constructor(
    private readonly options: StdioProxyOptions,
    private readonly write: (message: unknown) => void,
  ) {
    this.heart = options.heart;
    this.log = options.log ?? (() => {});
  }

  /** One line from the client. */
  async receive(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.write(errorResponse(null, PARSE_ERROR, "parse JSON-RPC message: not valid JSON"));
      return;
    }
    if (isRequest(message) && message.method === "initialize") {
      const answered = this.ready.then(() => this.initialize(message));
      this.ready = answered.catch(() => {});
      return answered;
    }
    if (isNotification(message) && message.method === "notifications/cancelled") {
      this.cancel(isObject(message.params) ? message.params.requestId : undefined);
      if (!this.legacy) return;
    }
    await this.ready;
    if (this.legacy) return this.legacy(message);
    if (isRequest(message)) return this.request(message);
    return this.forward(message);
  }

  private async initialize(request: Request): Promise<void> {
    if (this.legacy) return this.legacy(request);
    const reply = await this.heart.send(request);
    if (
      this.options.legacyFallback &&
      reply.kind === "failed" &&
      reply.failure.kind === "http" &&
      reply.failure.routeMissing
    ) {
      this.log(
        `${this.heart.endpoint} is not served (HTTP 404): this Anytype predates its built-in MCP server. ` +
          "Falling back to tools generated from its OpenAPI document; update Anytype to use the built-in server.",
      );
      try {
        this.legacy = await this.options.legacyFallback((message) => this.write(message));
      } catch (error) {
        this.fail(request, `Anytype has no built-in MCP server and the fallback failed to start: ${errorText(error)}`);
        return;
      }
      return this.legacy(request);
    }
    if (reply.kind === "messages") {
      reply.messages = reply.messages.map((message) => this.answerVersion(request, message));
    }
    this.relay(request, reply);
  }

  /** Answers the client's own revision when Anytype chose another and the client's is one the proxy can carry. */
  private answerVersion(request: Request, message: JsonObject): JsonObject {
    const asked = isObject(request.params) ? request.params.protocolVersion : undefined;
    if (
      message.id !== request.id ||
      !isObject(message.result) ||
      typeof asked !== "string" ||
      message.result.protocolVersion === asked ||
      !STDIO_PROTOCOL_VERSIONS.includes(asked)
    ) {
      return message;
    }
    return { ...message, result: { ...message.result, protocolVersion: asked } };
  }

  private async request(request: Request): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(request.id, controller);
    try {
      const local = this.localCall(request);
      if (local) {
        const result = await local(controller.signal).catch((error) => toolError(errorText(error)));
        if (!controller.signal.aborted) this.write(resultResponse(request.id, result));
        return;
      }
      const reply = await this.heart.send(request, controller.signal);
      // a cancelled request is not answered (MCP cancellation)
      if (controller.signal.aborted) return;
      this.relay(request, reply);
    } finally {
      if (this.inflight.get(request.id) === controller) this.inflight.delete(request.id);
    }
  }

  private localCall(request: Request): ((signal: AbortSignal) => Promise<JsonObject>) | undefined {
    const tools = this.options.localTools;
    const params = request.params;
    if (request.method !== "tools/call" || !tools || !isObject(params) || typeof params.name !== "string") {
      return undefined;
    }
    if (!tools.serves(params.name)) return undefined;
    const name = params.name;
    const args = isObject(params.arguments) ? params.arguments : {};
    return (signal) => tools.call(name, args, signal);
  }

  /** Notifications and client responses: Anytype acknowledges them; anything it answers is passed on. */
  private async forward(message: unknown): Promise<void> {
    const reply = await this.heart.send(message);
    if (reply.kind === "messages") reply.messages.forEach((m) => this.write(m));
    if (reply.kind === "failed") {
      const what = isObject(message) && typeof message.method === "string" ? message.method : "a message";
      this.log(`could not deliver ${what} to Anytype: ${describeFailure(reply.failure, this.heart)}`);
    }
  }

  private relay(request: Request, reply: HeartReply): void {
    switch (reply.kind) {
      case "cancelled":
        return;
      case "accepted":
        this.fail(request, "Anytype accepted the request without answering it");
        return;
      case "failed":
        this.fail(request, describeFailure(reply.failure, this.heart));
        return;
      case "messages": {
        let answered = false;
        for (let message of reply.messages) {
          // one message per POST: an error Anytype could not attribute is about this request
          if (message.id === null && "error" in message) message = { ...message, id: request.id };
          if (message.id === request.id && ("result" in message || "error" in message)) {
            answered = true;
            if (request.method === "tools/list") message = this.withLocalTools(message);
          }
          this.write(message);
        }
        if (!answered) this.fail(request, "Anytype's reply did not answer the request");
        return;
      }
    }
  }

  private withLocalTools(message: JsonObject): JsonObject {
    const tools = this.options.localTools;
    if (!tools || !isObject(message.result) || !Array.isArray(message.result.tools)) return message;
    const served = new Set(
      message.result.tools.map((tool: unknown) => (isObject(tool) && typeof tool.name === "string" ? tool.name : "")),
    );
    const local = tools.listing(served);
    if (local.length === 0) return message;
    return { ...message, result: { ...message.result, tools: [...message.result.tools, ...local] } };
  }

  /** A failure the proxy reports itself: in-band on tools/call, a JSON-RPC error elsewhere. */
  private fail(request: Request, text: string): void {
    if (request.method === "tools/call") this.write(resultResponse(request.id, toolError(text)));
    else this.write(errorResponse(request.id, INTERNAL_ERROR, text));
  }

  private cancel(id: unknown): void {
    if (typeof id !== "string" && typeof id !== "number") return;
    this.inflight.get(id)?.abort();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StartOptions {
  baseUrl: string;
  tier: Tier;
  headers: Record<string, string>;
  legacyFallback?: LegacyFallback;
  input?: Readable;
  output?: Writable;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export interface RunningProxy {
  /** Resolves when stdin has ended and the session (if any) is closed. */
  closed: Promise<void>;
  /** Ends the curated-tier session, if one is open. */
  close(): Promise<void>;
}

/** Wires stdin and stdout to Anytype's /mcp/{tier}. */
export function startStdioProxy(options: StartOptions): RunningProxy {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => console.error(line));
  const heart = new HeartClient({
    baseUrl: options.baseUrl,
    tier: options.tier,
    headers: options.headers,
    fetch: options.fetch,
  });
  const localTools =
    options.tier === "full"
      ? new LocalFileTools({ baseUrl: options.baseUrl, headers: options.headers, fetch: options.fetch })
      : undefined;
  // the host going away mid-answer is not an error worth crashing on
  output.on("error", (error) => log(`stdout: ${errorText(error)}`));
  const write = (message: unknown) => {
    output.write(JSON.stringify(message) + "\n");
  };
  const proxy = new StdioProxy(
    { heart, tier: options.tier, localTools, legacyFallback: options.legacyFallback, log },
    write,
  );

  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    proxy.receive(line).catch((error) => log(`anytype-mcp: ${errorText(error)}`));
  });
  const closed = new Promise<void>((resolve) => lines.once("close", resolve)).then(() => heart.close());
  return { closed, close: () => heart.close() };
}
