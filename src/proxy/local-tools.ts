// The two tools the proxy serves itself, beside Anytype's full tier: both need
// the filesystem of the machine the MCP host runs on, which Anytype's MCP
// server cannot see. Anytype's upload_file fetches a URL; download_file is
// excluded there because bytes have no text rendering. Here a download is
// saved to a private temporary file and its path returned, and a local file is
// uploaded through the same REST route the app uses (multipart), with the
// caller's own key. A tool Anytype starts serving under the same name takes
// precedence: the proxy then steps aside.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { saveDownload } from "../utils/download-file";
import { isObject, toolError, type JsonObject } from "./jsonrpc";

const definitions: JsonObject[] = [
  {
    name: "download_file",
    description:
      "Download a file's bytes to a private temporary directory on the computer running this MCP server and " +
      "return its local path, filename, media_type and size. file_id is the file object's id, as upload_file " +
      "and upload_local_file return it and file and image blocks reference it.",
    inputSchema: {
      type: "object",
      properties: {
        space_id: { type: "string", description: "Space id, from `list_spaces`" },
        file_id: { type: "string", description: "File object id" },
      },
      required: ["space_id", "file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_local_file",
    description:
      "Upload a file from the computer running this MCP server into a space, by its path. Returns the stored " +
      "file object's id, which file blocks, image blocks and icon_image values reference. For a file on the " +
      "web, use upload_file with its url.",
    inputSchema: {
      type: "object",
      properties: {
        space_id: { type: "string", description: "Space id, from `list_spaces`" },
        path: { type: "string", description: "Absolute path of the file; a leading ~/ means the home directory" },
        dry_run: { type: "boolean", description: "Validate and report without committing" },
      },
      required: ["space_id", "path"],
      additionalProperties: false,
    },
  },
];

export interface LocalFileToolsOptions {
  baseUrl: string;
  /** OPENAPI_MCP_HEADERS: Authorization carries the caller's key. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** A bad argument; its message is the repair the model reads. */
class ArgumentError extends Error {}
class UnreachableError extends Error {}

export class LocalFileTools {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private active = new Set(definitions.map((tool) => tool.name as string));

  constructor(options: LocalFileToolsOptions) {
    this.baseUrl = options.baseUrl;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The local tools to list beside Anytype's, leaving out any name Anytype already serves. */
  listing(served: ReadonlySet<string>): JsonObject[] {
    const tools = definitions.filter((tool) => !served.has(tool.name as string));
    this.active = new Set(tools.map((tool) => tool.name as string));
    return tools.map((tool) => structuredClone(tool));
  }

  serves(name: string): boolean {
    return this.active.has(name);
  }

  /** A tools/call result; failures are in-band so the model can read them. */
  async call(name: string, args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    try {
      switch (name) {
        case "download_file":
          return await this.download(args, signal);
        case "upload_local_file":
          return await this.upload(args, signal);
        default:
          return toolError(`${name} is not a local tool`);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof UnreachableError) {
        return toolError(
          `Cannot reach Anytype at ${this.baseUrl} (${error.message}). Ask the user to start the Anytype app; ` +
            "changing the call will not help.",
        );
      }
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  /** fetch, with a failure to connect told apart from everything after it. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.baseUrl).href, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
      throw new UnreachableError(
        typeof cause?.code === "string" ? cause.code : error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async download(args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    onlyArguments("download_file", args, ["space_id", "file_id"]);
    const space = segment(args, "space_id");
    const file = segment(args, "file_id");
    const response = await this.request(`/v2/spaces/${space}/files/${file}/content`, { headers: this.headers, signal });
    if (!response.ok) return toolError(restError(response.status, await response.text()));
    if (!response.body) return toolError("Anytype sent no file content");
    const saved = await saveDownload(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      response.headers,
      signal,
    );
    return { content: [{ type: "text", text: JSON.stringify(saved) }], structuredContent: { ...saved } };
  }

  private async upload(args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    onlyArguments("upload_local_file", args, ["space_id", "path", "dry_run"]);
    const space = segment(args, "space_id");
    const path = localPath(args.path);
    if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") {
      throw new ArgumentError("dry_run must be true or false");
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new ArgumentError(`no file at ${path}`);
    }
    if (!info.isFile()) throw new ArgumentError(`${path} is not a regular file`);

    const form = new FormData();
    form.append("file", await fileBlob(path), basename(path));
    const query = args.dry_run === true ? "?dry_run=true" : "";
    const response = await this.request(`/v2/spaces/${space}/files${query}`, {
      method: "POST",
      // a fresh key per call: the proxy does not retry, so it only marks the write
      headers: { ...this.headers, "Idempotency-Key": randomUUID() },
      body: form,
      signal,
    });
    const text = await response.text();
    if (!response.ok) return toolError(restError(response.status, text));
    const parsed = parseObject(text);
    return { content: [{ type: "text", text }], ...(parsed ? { structuredContent: parsed } : {}) };
  }
}

function onlyArguments(tool: string, args: JsonObject, allowed: string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ArgumentError(`${tool} takes ${allowed.join(", ")}; unexpected: ${unexpected.join(", ")}`);
  }
}

/** A path argument is one URL segment: an id, never a way onto another route. */
function segment(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "" || value === "." || value === ".." || value.includes("/")) {
    throw new ArgumentError(`${key} must be an id (one path segment); got ${JSON.stringify(value ?? null)}`);
  }
  return encodeURIComponent(value);
}

function localPath(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new ArgumentError("path must be a file path");
  const path = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
  if (!isAbsolute(path)) {
    throw new ArgumentError(
      `path must be absolute (the MCP server's working directory is not the user's); got ${value}`,
    );
  }
  return path;
}

/** Node 19.8+ reads the file lazily; older Node buffers it. */
async function fileBlob(path: string): Promise<Blob> {
  const open = (fs as { openAsBlob?: (path: string) => Promise<Blob> }).openAsBlob;
  return open ? await open(path) : new Blob([await readFile(path)]);
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Anytype's error envelope (message, issues, hints) with the status beside it. */
function restError(status: number, body: string): string {
  const envelope = parseObject(body);
  if (envelope) return JSON.stringify({ ...envelope, status });
  return `Anytype answered HTTP ${status}: ${body.trim().slice(0, 500) || "no details"}`;
}
