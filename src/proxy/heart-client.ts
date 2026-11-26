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
// A server older than /mcp has no such route: gin's plain-text 404.

import { debug } from "../utils/debug";
import type { Tier } from "./config";
import { isMessage, isObject, isRequest, type JsonObject } from "./jsonrpc";

export type HeartFailure =
  | { kind: "unreachable"; detail: string }
  | { kind: "timeout"; ms: number }
  /** routeMissing: a 404 that is not Anytype's JSON — the route does not exist on this server. */
  | { kind: "http"; status: number; message: string; routeMissing: boolean }
  | { kind: "unreadable"; status: number; detail: string };

export type HeartReply =
  /** JSON-RPC messages to relay, whatever the HTTP status they came with. */
  | { kind: "messages"; messages: JsonObject[] }
  | { kind: "accepted" }
  | { kind: "cancelled" }
  | { kind: "failed"; failure: HeartFailure };

export interface HeartClientOptions {
  baseUrl: string;
  tier: Tier;
  /** Sent on every request; Authorization carries the caller's own key. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Anytype bounds a call at 60 s itself; this only catches a connection that
 * never answers.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 2_000;

export class HeartClient {
  readonly endpoint: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId?: string;
  private protocolVersion?: string;
  private initializeParams?: unknown;
  private reinitializing?: Promise<boolean>;
  private reinitializeCount = 0;

  constructor(options: HeartClientOptions) {
    this.baseUrl = options.baseUrl;
    this.endpoint = new URL(`/mcp/${options.tier}`, options.baseUrl).href;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
   * Forwards one message. A curated-tier session that expired (Anytype idles
   * them out after 30 minutes) is re-opened with the client's own initialize
   * parameters and the message is sent once more: a stdio client has no way
   * to re-initialize by itself.
   */
  async send(message: unknown, signal?: AbortSignal): Promise<HeartReply> {
    const initialize = isRequest(message) && message.method === "initialize";
    if (initialize) {
      // a new initialize starts over; a session it replaces is ended, not leaked
      await this.close();
      this.initializeParams = message.params;
      this.protocolVersion = undefined;
    }
    const sentSession = this.sessionId;
    let reply = await this.post(message, signal);
    if (!initialize && sentSession && sessionGone(reply) && (await this.reinitialize(sentSession))) {
      reply = await this.post(message, signal);
    }
    if (initialize && reply.kind === "messages") {
      this.protocolVersion = answeredVersion(reply.messages, message.id);
    }
    return reply;
  }

  /** Ends a curated-tier session, best effort: Anytype caps sessions per key. */
  async close(): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    this.sessionId = undefined;
    const deadline = withDeadline(undefined, CLOSE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: this.requestHeaders({ "Mcp-Session-Id": id }),
        signal: deadline.signal,
      });
      await response.body?.cancel();
    } catch {
      // the session idles out on its own
    } finally {
      deadline.dispose();
    }
  }

  private reinitialize(stale: string): Promise<boolean> {
    if (this.reinitializing) return this.reinitializing;
    // another call already replaced the session
    if (this.sessionId !== stale) return Promise.resolve(this.sessionId !== undefined);
    this.reinitializing = this.openSession().finally(() => {
      this.reinitializing = undefined;
    });
    return this.reinitializing;
  }

  private async openSession(): Promise<boolean> {
    this.sessionId = undefined;
    const id = `anytype-mcp-reinitialize-${++this.reinitializeCount}`;
    const reply = await this.post({ jsonrpc: "2.0", id, method: "initialize", params: this.initializeParams });
    if (reply.kind !== "messages" || !this.sessionId) return false;
    if (!reply.messages.some((m) => m.id === id && isObject(m.result))) return false;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return true;
  }

  private requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.headers,
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...extra,
    };
  }

  private async post(message: unknown, signal?: AbortSignal): Promise<HeartReply> {
    const method = isObject(message) && typeof message.method === "string" ? message.method : "response";
    const started = Date.now();
    const deadline = withDeadline(signal, this.timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.requestHeaders({
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
        body: JSON.stringify(message),
        signal: deadline.signal,
      });
      body = await response.text();
    } catch (error) {
      if (signal?.aborted) return { kind: "cancelled" };
      if (deadline.timedOut()) return { kind: "failed", failure: { kind: "timeout", ms: this.timeoutMs } };
      return { kind: "failed", failure: { kind: "unreachable", detail: networkDetail(error) } };
    } finally {
      deadline.dispose();
    }
    debug("mcp", { method, status: response.status, durationMs: Date.now() - started });
    return this.interpret(response, body);
  }

  private interpret(response: Response, body: string): HeartReply {
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (response.status === 202) return { kind: "accepted" };

    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const messages = type.includes("text/event-stream") ? parseEventStream(body) : parseJsonMessages(body);
    if (messages.length > 0) return { kind: "messages", messages };
    if (response.ok) {
      if (body.trim() === "") return { kind: "accepted" };
      return {
        kind: "failed",
        failure: { kind: "unreadable", status: response.status, detail: `content-type ${type || "none"}` },
      };
    }
    const json = parseJson(body);
    return {
      kind: "failed",
      failure: {
        kind: "http",
        status: response.status,
        message: errorMessage(json, body, response.statusText),
        routeMissing: response.status === 404 && json === undefined,
      },
    };
  }
}

/** What the model or the host is told when Anytype could not be asked or refused at the HTTP level. */
export function describeFailure(failure: HeartFailure, client: { baseUrl: string; endpoint: string }): string {
  const path = new URL(client.endpoint).pathname;
  switch (failure.kind) {
    case "unreachable":
      return (
        `Cannot reach Anytype at ${client.baseUrl} (${failure.detail}). Ask the user to start the Anytype app, ` +
        "or to set ANYTYPE_API_BASE_URL if it listens elsewhere; changing the call will not help."
      );
    case "timeout":
      return `Anytype at ${client.baseUrl} did not answer within ${Math.round(failure.ms / 1000)} s. Ask the user whether the Anytype app is responding.`;
    case "unreadable":
      return `Anytype answered HTTP ${failure.status} without a JSON-RPC message (${failure.detail}).`;
    case "http":
      switch (failure.status) {
        case 401:
          return (
            `Anytype rejected the API key (HTTP 401: ${failure.message}). Ask the user to check the ` +
            '"Authorization": "Bearer <key>" entry of OPENAPI_MCP_HEADERS (Anytype → Settings → API keys); ' +
            "changing the call will not help."
          );
        case 403:
          return (
            `Anytype refused the API key (HTTP 403: ${failure.message}). Ask the user to create a key in ` +
            "Anytype → Settings → API keys and put it in OPENAPI_MCP_HEADERS; changing the call will not help."
          );
        case 404:
          if (failure.routeMissing) {
            return (
              `Anytype at ${client.baseUrl} does not serve MCP at ${path} (HTTP 404): this Anytype version ` +
              "predates its built-in MCP server. Ask the user to update the Anytype app."
            );
          }
          return `Anytype answered HTTP 404: ${failure.message}`;
        case 429:
          return `Anytype is busy (HTTP 429: ${failure.message}). Wait for other calls to finish, then retry.`;
        default:
          return `Anytype answered HTTP ${failure.status}: ${failure.message}`;
      }
  }
}

function sessionGone(reply: HeartReply): boolean {
  return (
    reply.kind === "failed" &&
    reply.failure.kind === "http" &&
    reply.failure.status === 404 &&
    !reply.failure.routeMissing
  );
}

function answeredVersion(messages: JsonObject[], id: unknown): string | undefined {
  for (const message of messages) {
    if (message.id === id && isObject(message.result) && typeof message.result.protocolVersion === "string") {
      return message.result.protocolVersion;
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

function parseJsonMessages(text: string): JsonObject[] {
  const parsed = parseJson(text);
  if (Array.isArray(parsed)) return parsed.filter(isMessage);
  return isMessage(parsed) ? [parsed] : [];
}

/** A buffered text/event-stream body: every `data:` payload that is a JSON-RPC message, in order. */
export function parseEventStream(text: string): JsonObject[] {
  const messages: JsonObject[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const parsed = parseJson(data);
    if (isMessage(parsed)) messages.push(parsed);
  }
  return messages;
}

function errorMessage(json: unknown, body: string, statusText: string): string {
  if (isObject(json) && typeof json.message === "string" && json.message) return json.message;
  const text = body.trim();
  return text ? text.slice(0, 500) : statusText || "no details";
}

function networkDetail(error: unknown): string {
  const cause = isObject(error) ? (error as { cause?: unknown }).cause : undefined;
  if (isObject(cause) && typeof cause.code === "string") return cause.code;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

/** An abort signal that fires on the caller's signal or after ms, whichever comes first (Node 18 has no AbortSignal.any). */
function withDeadline(signal: AbortSignal | undefined, ms: number) {
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
