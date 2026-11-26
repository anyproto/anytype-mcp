// A stand-in for anytype-heart's API server, written from its /mcp contract
// (core/api/server/mcp.go, core/api/wrapper/mcp.go): bearer auth before
// anything else, tiers small|large|full, MCP-Protocol-Version checked when
// sent, one JSON-RPC message per POST, notifications and responses 202,
// batches refused with a JSON-RPC error under HTTP 400, curated-tier
// sessions minted at initialize and required afterwards, GET 405, DELETE
// ending a session, and gin's plain-text 404 for a route the server lacks.
// Plus the two v2 file routes the local tools use.

import http from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_KEY = "test-key";
const HTTP_VERSIONS = ["2025-06-18", "2025-11-25"];
const TIERS = ["small", "large", "full"];

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type CallHandler = (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface FakeHeartOptions {
  /** An Anytype from before /mcp: every /mcp route is gin's plain 404. */
  withoutMcp?: boolean;
  tools?: Array<Record<string, unknown>>;
  /** The tools/call result; default echoes the arguments as text and structuredContent. */
  call?: CallHandler;
  /** Stored files the download route serves, by file id. */
  files?: Record<string, { name: string; type: string; bytes: Buffer }>;
  /** Served unauthenticated at /v2/docs/openapi.json, as Anytype does. */
  openapi?: unknown;
}

export const DEFAULT_TOOLS = [
  {
    name: "list_spaces",
    description: "List spaces",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "upload_file",
    description: "Upload a file. Stores a file fetched from a URL in the space.",
    inputSchema: {
      type: "object",
      properties: { space_id: { type: "string" }, url: { type: "string" } },
      required: ["space_id", "url"],
    },
  },
];

export class FakeHeart {
  readonly requests: RecordedRequest[] = [];
  readonly sessions = new Map<string, string>();
  url = "";
  private server = http.createServer((req, res) => void this.handle(req, res));
  private sessionCount = 0;

  constructor(private readonly options: FakeHeartOptions = {}) {}

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** What Anytype does to an idle session after 30 minutes. */
  expireSessions() {
    this.sessions.clear();
  }

  /** The JSON-RPC messages POSTed to /mcp, in order. */
  get posted(): Array<Record<string, any>> {
    return this.requests
      .filter((r) => r.method === "POST" && r.path.startsWith("/mcp/"))
      .map((r) => JSON.parse(r.body.toString("utf8")));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    this.requests.push({ method: req.method ?? "", path: url.pathname + url.search, headers: req.headers, body });

    if (url.pathname === "/v2/docs/openapi.json" && this.options.openapi) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.options.openapi));
      return;
    }
    const mcp = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    const download = /^\/v2\/spaces\/([^/]+)\/files\/([^/]+)\/content$/.exec(url.pathname);
    const upload = /^\/v2\/spaces\/([^/]+)\/files$/.exec(url.pathname);
    if ((mcp && this.options.withoutMcp) || (!mcp && !download && !upload)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("404 page not found");
      return;
    }
    if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
      return refuse(res, 401, "unauthorized", "invalid authorization header");
    }
    if (download) return this.download(res, decodeURIComponent(download[2]));
    if (upload) return this.upload(req, res, url, body);
    return this.mcp(req, res, mcp![1], body);
  }

  private mcp(req: http.IncomingMessage, res: http.ServerResponse, tier: string, body: Buffer) {
    if (!TIERS.includes(tier)) return refuse(res, 404, "not_found", `unknown MCP tier "${tier}"`);
    const version = req.headers["mcp-protocol-version"] as string | undefined;
    if (version && !HTTP_VERSIONS.includes(version)) {
      return refuse(res, 400, "bad_request", `unsupported MCP-Protocol-Version "${version}"`);
    }
    const curated = tier !== "full";
    const sessionHeader = req.headers["mcp-session-id"] as string | undefined;
    const live = sessionHeader !== undefined && this.sessions.get(sessionHeader) === tier;
    if (req.method === "GET") {
      if (sessionHeader && !live) return refuse(res, 404, "not_found", "unknown or expired MCP session");
      return refuse(res, 405, "method_not_allowed", "no GET stream");
    }
    if (req.method === "DELETE") {
      if (!curated || !sessionHeader) return refuse(res, 400, "bad_request", "DELETE ends a curated session");
      if (!live) return refuse(res, 404, "not_found", "unknown or expired MCP session");
      this.sessions.delete(sessionHeader);
      res.writeHead(204).end();
      return;
    }

    let message: any;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      return rpcRefusal(res, -32700, "parse JSON-RPC message: not valid JSON");
    }
    if (Array.isArray(message)) {
      return rpcRefusal(res, -32600, "JSON-RPC batching is not supported — send one message at a time");
    }
    if (message.id === undefined) {
      if (curated && sessionHeader && !live) return refuse(res, 404, "not_found", "unknown or expired MCP session");
      res.writeHead(202).end();
      return;
    }

    const headers: Record<string, string> = {};
    if (curated) {
      if (sessionHeader) {
        if (!live)
          return refuse(res, 404, "not_found", "unknown or expired MCP session — start a new one with initialize");
      } else if (message.method === "initialize") {
        const id = `session-${++this.sessionCount}`;
        this.sessions.set(id, tier);
        headers["Mcp-Session-Id"] = id;
      } else {
        return refuse(res, 400, "bad_request", `Mcp-Session-Id is required on the ${tier} tier after initialize`);
      }
    }
    void this.answer(message).then((answer) => {
      res.writeHead(200, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(answer));
    });
  }

  private async answer(message: any): Promise<Record<string, unknown>> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    const error = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    switch (message.method) {
      case "initialize": {
        const asked = message.params?.protocolVersion;
        return reply({
          protocolVersion: HTTP_VERSIONS.includes(asked) ? asked : HTTP_VERSIONS[HTTP_VERSIONS.length - 1],
          capabilities: { tools: {} },
          serverInfo: { name: "anytype", version: "1" },
          instructions: "fake heart instructions",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: this.options.tools ?? DEFAULT_TOOLS });
      case "tools/call": {
        const tools = this.options.tools ?? DEFAULT_TOOLS;
        const name = message.params?.name;
        if (!tools.some((t) => t.name === name)) return error(-32602, `unknown tool "${name}"`);
        const args = message.params?.arguments ?? {};
        if (this.options.call) return reply(await this.options.call(name, args));
        return reply({ content: [{ type: "text", text: JSON.stringify(args) }], structuredContent: args });
      }
      default:
        return error(-32601, `method "${message.method}" not found`);
    }
  }

  private download(res: http.ServerResponse, fileId: string) {
    const file = this.options.files?.[fileId];
    if (!file) {
      res
        .writeHead(404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ object: "error", status: 404, code: "not_found", message: `file ${fileId} not found` }));
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": file.type,
        "Content-Disposition": `attachment; filename="${file.name}"`,
      })
      .end(file.bytes);
  }

  private upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: Buffer) {
    if (!(req.headers["content-type"] ?? "").startsWith("multipart/form-data")) {
      return refuse(res, 400, "bad_request", "expected a multipart form");
    }
    if (!body.includes(Buffer.from('name="file"'))) return refuse(res, 400, "bad_request", "missing file field");
    const dryRun = url.searchParams.get("dry_run") === "true";
    res
      .writeHead(dryRun ? 200 : 201, { "Content-Type": "application/json" })
      .end(JSON.stringify(dryRun ? { dry_run: true } : { object: "file", id: "uploaded-file-id" }));
  }
}

/** Anytype's HTTP-level refusal: util.CodeToApiError's shape, never JSON-RPC. */
function refuse(res: http.ServerResponse, status: number, code: string, message: string) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify({ object: "error", status, code, message }));
}

/** A malformed envelope: the JSON-RPC error as the body of an HTTP 400. */
function rpcRefusal(res: http.ServerResponse, code: number, message: string) {
  res
    .writeHead(400, { "Content-Type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}
