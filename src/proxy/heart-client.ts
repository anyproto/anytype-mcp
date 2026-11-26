// The HTTP half of the proxy: one JSON-RPC message per POST to Anytype's
// built-in MCP server at /mcp/{tier} (anytype-heart core/api/server/mcp.go,
// Streamable HTTP with JSON responses). The contract this client relies on:
//
// - a request is answered 200 with one JSON-RPC response; a notification or a
//   client response is acknowledged 202 with an empty body;
// - authentication and admission failures are plain HTTP errors
//   ({"object":"error","status","code","message"}), never JSON-RPC, and a
//   malformed envelope is a 400 whose body is the JSON-RPC error;
// - `full` keeps no session; `small` and `large` mint Mcp-Session-Id at
//   initialize, require it afterwards, and answer 404 once it has expired;
// - MCP-Protocol-Version, when sent, must name a revision the server speaks.
//
// An Anytype older than /mcp has no such route: gin's plain-text 404.

import { debug } from "../utils/debug";
import type { Tier } from "./config";
import { anytypeError, redactor } from "./errors";
import { isObject, oneLine, rawMember, sameId, type Inbound, type JsonObject } from "./jsonrpc";

export type HeartFailure =
  | { kind: "unreachable"; code?: string }
  | { kind: "timeout"; ms: number }
  /** message: Anytype's own error message, when the body was Anytype's error JSON. */
  | { kind: "http"; status: number; message?: string; routeMissing: boolean }
  | { kind: "redirect"; status: number }
  | { kind: "unreadable"; status: number; detail: string }
  /** Anytype answered the proxy's own initialize with a JSON-RPC error. */
  | { kind: "rejected"; message: string }
  | { kind: "closed" };

/** One JSON-RPC message from Anytype: its text as sent (relayed as is) and its parse. */
export interface HeartMessage {
  raw: string;
  parsed: JsonObject;
}

export type HeartReply =
  | { kind: "messages"; messages: HeartMessage[] }
  | { kind: "accepted" }
  | { kind: "cancelled" }
  /** The session expired; a new one is open, but this tool call was not run in it. */
  | { kind: "sessionExpired" }
  | { kind: "failed"; failure: HeartFailure };

export interface HeartClientOptions {
  baseUrl: string;
  tier: Tier;
  /** Sent on every request; Authorization carries the caller's own key. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Anytype bounds a call at 60 s itself; this only catches a connection that never answers. */
export const DEFAULT_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 2_000;
/**
 * Anytype caps the REST body of one call at 32 MiB, and the full tier returns
 * it twice: JSON-escaped as text content (up to twice its size) and as
 * structuredContent. 128 MiB holds that worst case with room to spare.
 */
const MAX_REPLY_BYTES = 128 << 20;
/** An error response is read only this far: it is a diagnostic, not content. */
const MAX_ERROR_BYTES = 64 << 10;

export class HeartClient {
  readonly endpoint: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId?: string;
  private protocolVersion?: string;
  private initializeParams?: JsonObject;
  /** Set when Anytype ended the session; the next message opens a new one first. */
  private needsSession = false;
  private renewal?: Promise<HeartFailure | undefined>;
  private initializing?: Promise<unknown>;
  private closing = false;
  private renewals = 0;
  /** Sessions the proxy opened in place of an expired one. */
  private resetCount = 0;
  /** A reset no tool call has been told about yet. */
  private resetPending = false;
  private readonly redact: (text: string) => string;

  constructor(options: HeartClientOptions) {
    this.baseUrl = options.baseUrl;
    this.endpoint = new URL(`/mcp/${options.tier}`, options.baseUrl).href;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.redact = redactor(this.headers);
  }

  /**
   * How many times the session was reset. The stdio side reads it when a
   * request arrives, so a tool call that waited across a reset is refused.
   */
  get resets(): number {
    return this.resetCount;
  }

  /** The curated tiers' session, if one is open. */
  get session(): string | undefined {
    return this.sessionId;
  }

  /** The revision Anytype answered initialize with; sent as MCP-Protocol-Version from then on. */
  get negotiatedVersion(): string | undefined {
    return this.protocolVersion;
  }

  /**
   * Forwards one message. On the curated tiers Anytype ends a session idle for
   * 30 minutes; a stdio client cannot re-initialize, so the proxy opens a new
   * session with the client's own initialize parameters. Numbered results of
   * the old session may name other objects in the new one, so no tool call
   * runs across a reset: the first tool call after it — or one that was
   * waiting while it happened (seenResets is the count when it arrived) — is
   * answered sessionExpired instead, whatever message discovered the expiry.
   */
  async send(message: Inbound, signal?: AbortSignal, seenResets = this.resetCount): Promise<HeartReply> {
    if (this.closing) return { kind: "failed", failure: { kind: "closed" } };
    if (message.kind === "request" && message.method === "initialize") return this.initialize(message);
    const toolCall = message.method === "tools/call";
    const crossedReset = () => toolCall && (this.resetPending || seenResets !== this.resetCount);
    const expired = (): HeartReply => {
      this.resetPending = false;
      return { kind: "sessionExpired" };
    };
    if (this.needsSession) {
      const failure = await this.renew();
      if (failure) return { kind: "failed", failure };
    }
    if (crossedReset()) return expired();
    const sent = this.sessionId;
    const reply = await this.post(message.raw, signal, message.method);
    if (!sent || !sessionGone(reply)) return reply;
    if (this.sessionId === sent) {
      this.sessionId = undefined;
      this.needsSession = true;
    }
    const failure = await this.renew();
    if (failure) return { kind: "failed", failure };
    if (toolCall) return expired();
    if (signal?.aborted) return { kind: "cancelled" };
    // anything else is resent; the reset stays pending for the next tool call
    return this.post(message.raw, signal, message.method);
  }

  /**
   * Ends a curated-tier session (Anytype caps sessions per key), after any
   * initialize still in flight has answered, so a session minted while the
   * proxy shuts down is ended too.
   */
  async close(): Promise<void> {
    this.closing = true;
    await this.initializing?.catch(() => {});
    await this.renewal?.catch(() => {});
    await this.endSession();
  }

  /** Not cancellable (MCP forbids cancelling initialize): its answer may carry a session to end later. */
  private async initialize(message: Inbound): Promise<HeartReply> {
    const run = async (): Promise<HeartReply> => {
      // a new initialize starts over; the session it replaces is ended, not leaked
      await this.endSession();
      this.needsSession = false;
      this.resetPending = false;
      this.initializeParams = message.params;
      this.protocolVersion = undefined;
      const reply = await this.post(message.raw, undefined, "initialize");
      if (reply.kind === "messages") this.protocolVersion = answeredVersion(reply.messages, message.id!);
      // Anytype mints a curated session before it checks the params: a refused
      // initialize must not leave one behind for later calls to use
      if (!initializeSucceeded(reply, message.id!)) await this.endSession();
      return reply;
    };
    const running = run();
    this.initializing = running;
    try {
      return await running;
    } finally {
      if (this.initializing === running) this.initializing = undefined;
    }
  }

  /** One renewal at a time; every message that needs it waits for the same one. */
  private renew(): Promise<HeartFailure | undefined> {
    this.renewal ??= this.openSession().finally(() => {
      this.renewal = undefined;
    });
    return this.renewal;
  }

  private async openSession(): Promise<HeartFailure | undefined> {
    if (this.closing) return { kind: "closed" };
    if (!this.needsSession) return undefined;
    const id = `"anytype-mcp-renew-${++this.renewals}"`;
    const params = JSON.stringify(this.initializeParams ?? {});
    const reply = await this.post(`{"jsonrpc":"2.0","id":${id},"method":"initialize","params":${params}}`);
    if (reply.kind === "failed") return reply.failure;
    const answer = reply.kind === "messages" ? reply.messages.find((m) => idOf(m) && sameId(idOf(m)!, id)) : undefined;
    if (answer && isObject(answer.parsed.error)) {
      await this.endSession();
      const said = boundedText(answer.parsed.error.message);
      return { kind: "rejected", message: said ? this.redact(said) : "no details" };
    }
    if (!answer || !this.sessionId) {
      return { kind: "unreadable", status: 200, detail: "initialize opened no session" };
    }
    this.needsSession = false;
    this.resetCount++;
    this.resetPending = true;
    await this.post('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    return undefined;
  }

  private async endSession(): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    this.sessionId = undefined;
    const deadline = withDeadline(undefined, CLOSE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: this.requestHeaders({ "Mcp-Session-Id": id }),
        redirect: "manual",
        signal: deadline.signal,
      });
      await response.body?.cancel();
    } catch {
      // the session idles out on its own
    } finally {
      deadline.dispose();
    }
  }

  private requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.headers,
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...extra,
    };
  }

  private async post(body: string, signal?: AbortSignal, method = "renewal"): Promise<HeartReply> {
    const started = Date.now();
    const deadline = withDeadline(signal, this.timeoutMs);
    let response: Response;
    let text: string | undefined;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.requestHeaders({
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
        body,
        // a redirect would resend the message (tool arguments included) elsewhere
        redirect: "manual",
        signal: deadline.signal,
      });
      text = await readBounded(response, response.ok ? MAX_REPLY_BYTES : MAX_ERROR_BYTES);
    } catch (error) {
      if (signal?.aborted) return { kind: "cancelled" };
      if (deadline.timedOut()) return { kind: "failed", failure: { kind: "timeout", ms: this.timeoutMs } };
      return { kind: "failed", failure: { kind: "unreachable", code: networkCode(error) } };
    } finally {
      deadline.dispose();
    }
    debug("mcp", { method, status: response.status, durationMs: Date.now() - started });
    return this.interpret(response, text);
  }

  private interpret(response: Response, body: string | undefined): HeartReply {
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const status = response.status;
    if (status === 202) return { kind: "accepted" };
    if (status >= 300 && status < 400) return { kind: "failed", failure: { kind: "redirect", status } };
    if (body === undefined) {
      return { kind: "failed", failure: { kind: "unreadable", status, detail: "the response is too large" } };
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const messages = type.includes("text/event-stream") ? parseEventStream(body) : parseJsonMessages(body);
    if (messages.length > 0) return { kind: "messages", messages };
    if (response.ok) {
      if (body.trim() === "") return { kind: "accepted" };
      return { kind: "failed", failure: { kind: "unreadable", status, detail: `content-type ${type || "none"}` } };
    }
    const json = parseJson(body);
    return {
      kind: "failed",
      failure: {
        kind: "http",
        status,
        // only Anytype's own error shape is quoted, its message bounded and with the key redacted
        message: anytypeError(json, status, this.redact)?.message,
        routeMissing: status === 404 && json === undefined,
      },
    };
  }
}

/**
 * What the model or the host is told when Anytype could not be asked or
 * refused at the HTTP level. Only Anytype's own error message is quoted; a
 * body that is not Anytype's error JSON (a gateway page) is not.
 */
export function describeFailure(failure: HeartFailure, client: { baseUrl: string; endpoint: string }): string {
  const path = new URL(client.endpoint).pathname;
  const said = (f: { status: number; message?: string }) =>
    f.message ? `HTTP ${f.status}: ${f.message}` : `HTTP ${f.status}`;
  switch (failure.kind) {
    case "unreachable":
      return (
        `Cannot reach Anytype at ${client.baseUrl}${failure.code ? ` (${failure.code})` : ""}. Ask the user to start ` +
        "the Anytype app, or to set ANYTYPE_API_BASE_URL if it listens elsewhere; changing the call will not help."
      );
    case "timeout":
      return `Anytype at ${client.baseUrl} did not answer within ${Math.round(failure.ms / 1000)} s. Ask the user whether the Anytype app is responding.`;
    case "redirect":
      return `Anytype at ${client.baseUrl} answered HTTP ${failure.status} with a redirect, which is not followed. Ask the user to check ANYTYPE_API_BASE_URL.`;
    case "unreadable":
      return `Anytype answered HTTP ${failure.status} without a usable JSON-RPC message (${failure.detail}).`;
    case "rejected":
      return `Anytype refused to open a new session: ${failure.message}`;
    case "closed":
      return "The Anytype MCP proxy is shutting down.";
    case "http":
      switch (failure.status) {
        case 401:
          return (
            `Anytype rejected the API key (${said(failure)}). Ask the user to check the ` +
            '"Authorization": "Bearer <key>" entry of OPENAPI_MCP_HEADERS (Anytype → Settings → API keys); ' +
            "changing the call will not help."
          );
        case 403:
          return (
            `Anytype refused the request (${said(failure)}). Ask the user to check the API key's scope, or to create ` +
            "a key in Anytype → Settings → API keys; changing the call will not help."
          );
        case 404:
          if (failure.routeMissing) {
            return (
              `Anytype at ${client.baseUrl} does not serve MCP at ${path} (HTTP 404). The built-in MCP server needs ` +
              "Anytype with heart >= 0.51.6 (the first version with /mcp). Ask the user to update Anytype, or to pin " +
              "@anyproto/anytype-mcp@2.0.3 for an older Anytype."
            );
          }
          return `Anytype answered ${said(failure)}`;
        case 429:
          return `Anytype is busy (${said(failure)}). Wait for other calls to finish, then retry.`;
        default:
          return `Anytype answered ${said(failure)}`;
      }
  }
}

/** Whether Anytype answered this initialize with a result (not an error, not an HTTP refusal). */
export function initializeSucceeded(reply: HeartReply, id: string): boolean {
  return (
    reply.kind === "messages" &&
    reply.messages.some((m) => {
      const answers = idOf(m);
      return answers !== undefined && sameId(answers, id) && isObject(m.parsed.result);
    })
  );
}

function sessionGone(reply: HeartReply): boolean {
  return (
    reply.kind === "failed" &&
    reply.failure.kind === "http" &&
    reply.failure.status === 404 &&
    !reply.failure.routeMissing
  );
}

export function idOf(message: HeartMessage): string | undefined {
  return rawMember(message.raw, "id");
}

function answeredVersion(messages: HeartMessage[], id: string): string | undefined {
  for (const message of messages) {
    const result = message.parsed.result;
    const answers = idOf(message);
    if (answers && sameId(answers, id) && isObject(result) && typeof result.protocolVersion === "string") {
      return result.protocolVersion;
    }
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJsonMessages(text: string): HeartMessage[] {
  const parsed = parseJson(text);
  if (isObject(parsed) && parsed.jsonrpc === "2.0") return [{ raw: oneLine(text), parsed }];
  return [];
}

/** A buffered text/event-stream body: every `data:` payload that is a JSON-RPC message, in order. */
export function parseEventStream(text: string): HeartMessage[] {
  const messages: HeartMessage[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    messages.push(...parseJsonMessages(data));
  }
  return messages;
}

/** A diagnostic string from Anytype, bounded and on one line. */
function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The body as text, or undefined past limit bytes (the rest is not read). */
export async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A system error code (ECONNREFUSED, ...) and nothing else: fetch's messages
 * can quote request headers, which carry the key.
 */
export function networkCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(cause.code) ? cause.code : undefined;
}

export interface Deadline {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

/** An abort signal that fires on the caller's signal or after ms, whichever comes first (Node 18 has no AbortSignal.any). */
export function withDeadline(signal: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
