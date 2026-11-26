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
import { rawMember } from "../jsonrpc";

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
  /**
   * Runs before anything else; returning true means it answered the request
   * itself (a 429, a delay, a redirect...).
   */
  intercept?: (request: RecordedRequest, res: http.ServerResponse) => boolean | Promise<boolean>;
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
    const recorded = { method: req.method ?? "", path: url.pathname + url.search, headers: req.headers, body };
    this.requests.push(recorded);
    if (this.options.intercept && (await this.options.intercept(recorded, res))) return;

    const mcp = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    const download = /^\/v2\/spaces\/([^/]+)\/files\/([^/]+)\/content$/.exec(url.pathname);
    const upload = /^\/v2\/spaces\/([^/]+)\/files$/.exec(url.pathname);
    const object = /^\/v2\/spaces\/([^/]+)\/objects\/([^/]+)$/.exec(url.pathname);
    if ((mcp && this.options.withoutMcp) || (!mcp && !download && !upload && !object)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("404 page not found");
      return;
    }
    if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
      return refuse(res, 401, "unauthorized", "invalid authorization header");
    }
    if (object) return this.object(res, decodeURIComponent(object[2]));
    if (download) return this.download(req, res, decodeURIComponent(download[2]));
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
    // the id goes back as the exact text it came in, as Anytype's json.RawMessage does
    const id = rawMember(body.toString("utf8"), "id")!;
    void this.answer(message).then((answer) => {
      const { id: _parsed, ...rest } = answer;
      res
        .writeHead(200, { "Content-Type": "application/json", ...headers })
        .end(JSON.stringify(rest).replace(/^\{/, `{"id":${id},`));
    });
  }

  private async answer(message: any): Promise<Record<string, unknown>> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    const error = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    switch (message.method) {
      case "initialize": {
        const asked = message.params?.protocolVersion;
        // like Anytype: the session is already minted when the params are refused
        if (asked !== undefined && typeof asked !== "string")
          return error(-32602, "initialize params: bad protocolVersion");
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

  /**
   * A file object as Anytype serves it: an AnyBlock document whose
   * properties.name has no extension and properties.file_ext holds it
   * (observed against a real heart, develop 2026-11).
   */
  private object(res: http.ServerResponse, id: string) {
    const file = this.options.files?.[id];
    if (!file) return refuse(res, 404, "not_found", `object ${id} not found`);
    const ext = /\.([^.]*)$/.exec(file.name)?.[1];
    const properties = { name: file.name.replace(/\.[^.]*$/, ""), ...(ext ? { file_ext: ext } : {}) };
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ kind: "file_object", id, type: "file", properties, blocks: [] }));
  }

  /** Like Anytype's: no Content-Disposition, and a Range header is honoured with a 206. */
  private download(req: http.IncomingMessage, res: http.ServerResponse, fileId: string) {
    const file = this.options.files?.[fileId];
    if (!file) return refuse(res, 404, "not_found", `file ${fileId} not found`);
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      res
        .writeHead(206, {
          "Content-Type": file.type,
          "Content-Range": `bytes ${start}-${end}/${file.bytes.length}`,
        })
        .end(file.bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Type": file.type }).end(file.bytes);
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
